use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

const RING_SECONDS: usize = 2;
const PREFETCH_THRESHOLD: usize = 16 * 1024;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub loaded: bool,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub title: String,
    pub path: String,
    pub codec: String,
    pub sample_rate: u32,
    pub bits: Option<u32>,
    pub channels: usize,
    pub output_mode: String,
    pub output_rate: u32,
    pub output_channels: usize,
    pub device: String,
    pub underruns: u64,
    pub error: Option<String>,
}

#[derive(Default)]
struct Meta {
    loaded: bool,
    title: String,
    path: String,
    codec: String,
    sample_rate: u32,
    bits: Option<u32>,
    channels: usize,
    duration: f64,
    output_mode: String,
    output_rate: u32,
    output_channels: usize,
    device: String,
    error: Option<String>,
}

struct Shared {
    meta: Mutex<Meta>,
    playing: AtomicBool,
    played_samples: AtomicU64,
    base_secs: AtomicU64,
    volume_bits: AtomicU32,
    underruns: AtomicU64,
}

impl Shared {
    fn new() -> Self {
        Self {
            meta: Mutex::new(Meta::default()),
            playing: AtomicBool::new(false),
            played_samples: AtomicU64::new(0),
            base_secs: AtomicU64::new(0.0f64.to_bits()),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            underruns: AtomicU64::new(0),
        }
    }

    fn set_base(&self, secs: f64) {
        self.base_secs.store(secs.to_bits(), Ordering::Relaxed);
    }

    fn base(&self) -> f64 {
        f64::from_bits(self.base_secs.load(Ordering::Relaxed))
    }

    fn snapshot(&self) -> PlayerSnapshot {
        let meta = self.meta.lock().expect("player meta poisoned");
        // played_samples 记录的是帧数，位置只按采样率换算，不能再除声道数
        let played = self.played_samples.load(Ordering::Relaxed) as f64
            / (meta.output_rate.max(1) as f64);
        let mut position = self.base() + played;
        if meta.duration > 0.0 {
            position = position.min(meta.duration);
        }

        PlayerSnapshot {
            loaded: meta.loaded,
            playing: self.playing.load(Ordering::Relaxed),
            position,
            duration: meta.duration,
            title: meta.title.clone(),
            path: meta.path.clone(),
            codec: meta.codec.clone(),
            sample_rate: meta.sample_rate,
            bits: meta.bits,
            channels: meta.channels,
            output_mode: meta.output_mode.clone(),
            output_rate: meta.output_rate,
            output_channels: meta.output_channels,
            device: meta.device.clone(),
            underruns: self.underruns.load(Ordering::Relaxed),
            error: meta.error.clone(),
        }
    }
}

enum Command {
    Load(PathBuf),
    Play,
    Pause,
    Seek(f64),
    SetVolume(f32),
}

pub struct AudioEngine {
    tx: Sender<Command>,
    shared: Arc<Shared>,
}

impl AudioEngine {
    pub fn spawn<F>(on_state: F) -> Self
    where
        F: Fn(PlayerSnapshot) + Send + 'static,
    {
        let shared = Arc::new(Shared::new());
        let worker_shared = Arc::clone(&shared);
        let (tx, rx) = mpsc::channel();

        thread::Builder::new()
            .name("matemusic-audio".to_string())
            .spawn(move || worker_loop(rx, worker_shared, on_state))
            .expect("failed to spawn audio thread");

        Self { tx, shared }
    }

    pub fn load(&self, path: PathBuf) {
        let _ = self.tx.send(Command::Load(path));
    }

    pub fn play(&self) {
        let _ = self.tx.send(Command::Play);
    }

    pub fn pause(&self) {
        let _ = self.tx.send(Command::Pause);
    }

    pub fn seek(&self, secs: f64) {
        let _ = self.tx.send(Command::Seek(secs));
    }

    pub fn set_volume(&self, volume: f32) {
        let _ = self.tx.send(Command::SetVolume(volume.clamp(0.0, 1.0)));
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.shared.snapshot()
    }
}

struct TrackInfo {
    title: String,
    codec: String,
    sample_rate: u32,
    bits: Option<u32>,
    channels: usize,
    duration: f64,
}

struct LinearResampler {
    ratio: f64,
    pos: f64,
    prev: Vec<f32>,
    src_channels: usize,
    out_channels: usize,
    started: bool,
}

impl LinearResampler {
    fn new(src_rate: u32, src_channels: usize, out_rate: u32, out_channels: usize) -> Self {
        Self {
            ratio: src_rate as f64 / out_rate.max(1) as f64,
            pos: 0.0,
            prev: vec![0.0; out_channels],
            src_channels: src_channels.max(1),
            out_channels: out_channels.max(1),
            started: false,
        }
    }

    fn reset(&mut self) {
        self.pos = 0.0;
        self.prev.fill(0.0);
        self.started = false;
    }

    fn map_channel(frame: &[f32], src_ch: usize, out_ch: usize, channel: usize) -> f32 {
        if src_ch == 1 {
            return frame[0];
        }
        if out_ch == 1 {
            let sum: f32 = frame.iter().sum();
            return sum / src_ch as f32;
        }
        if channel < src_ch {
            frame[channel]
        } else {
            0.0
        }
    }

    fn process(&mut self, interleaved: &[f32], out: &mut Vec<f32>) {
        let frames = interleaved.len() / self.src_channels;
        for f in 0..frames {
            let frame = &interleaved[f * self.src_channels..(f + 1) * self.src_channels];

            if !self.started {
                for c in 0..self.out_channels {
                    self.prev[c] = Self::map_channel(frame, self.src_channels, self.out_channels, c);
                }
                self.started = true;
                continue;
            }

            while self.pos < 1.0 {
                for c in 0..self.out_channels {
                    let cur = Self::map_channel(frame, self.src_channels, self.out_channels, c);
                    let prev = self.prev[c];
                    out.push(prev + (cur - prev) * self.pos as f32);
                }
                self.pos += self.ratio;
            }

            self.pos -= 1.0;
            for c in 0..self.out_channels {
                self.prev[c] = Self::map_channel(frame, self.src_channels, self.out_channels, c);
            }
        }
    }
}

struct Session {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    resampler: LinearResampler,
    sample_buf: Option<SampleBuffer<f32>>,
    sample_spec: Option<(u32, usize)>,
    pending: Vec<f32>,
    finished: bool,
}

impl Session {
    fn open(path: &Path, out_rate: u32, out_channels: usize) -> Result<(Self, TrackInfo), String> {
        let file =
            File::open(path).map_err(|e| format!("无法打开文件 {}: {e}", path.display()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions {
                    enable_gapless: true,
                    ..Default::default()
                },
                &MetadataOptions::default(),
            )
            .map_err(|e| format!("无法识别容器格式: {e}"))?;

        let format = probed.format;
        let track = format
            .default_track()
            .ok_or_else(|| "文件里没有可播放的默认音轨".to_string())?;
        let track_id = track.id;
        let params = track.codec_params.clone();

        let codec = symphonia::default::get_codecs()
            .get_codec(params.codec)
            .map(|d| d.short_name.to_string())
            .unwrap_or_else(|| format!("codec#{}", params.codec));

        let sample_rate = params.sample_rate.unwrap_or(0);
        let channels = params.channels.map(|c| c.count()).unwrap_or(0);
        if sample_rate == 0 || channels == 0 {
            return Err("解码结果缺少采样率或声道信息".to_string());
        }

        let duration = match (params.time_base, params.n_frames) {
            (Some(tb), Some(frames)) => {
                let t = tb.calc_time(frames);
                t.seconds as f64 + t.frac
            }
            _ => 0.0,
        };

        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| format!("无法创建解码器: {e}"))?;

        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未知曲目")
            .to_string();

        let info = TrackInfo {
            title,
            codec,
            sample_rate,
            bits: params.bits_per_sample,
            channels,
            duration,
        };

        let session = Self {
            format,
            decoder,
            track_id,
            resampler: LinearResampler::new(sample_rate, channels, out_rate, out_channels),
            sample_buf: None,
            sample_spec: None,
            pending: Vec::new(),
            finished: false,
        };

        Ok((session, info))
    }

    fn seek(&mut self, secs: f64) -> Result<(), String> {
        let secs = secs.max(0.0);
        let time = Time::new(secs as u64, secs.fract());
        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|e| format!("跳转失败: {e}"))?;
        self.decoder.reset();
        self.resampler.reset();
        self.sample_buf = None;
        self.sample_spec = None;
        self.pending.clear();
        self.finished = false;
        Ok(())
    }

    fn decode_next(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }

        let packet = match self.format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => {
                self.finished = true;
                return Ok(());
            }
            Err(SymphoniaError::ResetRequired) => {
                self.finished = true;
                return Ok(());
            }
            Err(e) => return Err(format!("读取数据包失败: {e}")),
        };

        if packet.track_id() != self.track_id {
            return Ok(());
        }

        match self.decoder.decode(&packet) {
            Ok(audio_buf) => {
                let spec = *audio_buf.spec();
                let need = audio_buf.capacity();
                let rebuild = match (&self.sample_buf, self.sample_spec) {
                    (Some(buf), Some((rate, channels))) => {
                        buf.capacity() < need
                            || rate != spec.rate
                            || channels != spec.channels.count()
                    }
                    _ => true,
                };
                if rebuild {
                    self.sample_buf = Some(SampleBuffer::<f32>::new(need as u64, spec));
                    self.sample_spec = Some((spec.rate, spec.channels.count()));
                }
                let buf = self.sample_buf.as_mut().expect("sample buffer initialized above");
                buf.copy_interleaved_ref(audio_buf);
                self.resampler.process(buf.samples(), &mut self.pending);
            }
            Err(SymphoniaError::DecodeError(_)) => {}
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => {
                self.finished = true;
            }
            Err(e) => return Err(format!("解码失败: {e}")),
        }

        Ok(())
    }
}

fn set_error(shared: &Shared, message: String) {
    eprintln!("audio error: {message}");
    if let Ok(mut meta) = shared.meta.lock() {
        meta.error = Some(message);
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    consumer: HeapCons<f32>,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let out_channels = config.channels as usize;
    let mut consumer = consumer;
    let mut scratch = [0.0f32; 1024];
    let err_shared = Arc::clone(&shared);

    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                let playing = shared.playing.load(Ordering::Relaxed);
                let volume = f32::from_bits(shared.volume_bits.load(Ordering::Relaxed));
                let mut offset = 0;
                let mut popped_total = 0usize;

                while offset < data.len() {
                    let n = (data.len() - offset).min(scratch.len());
                    let popped = if playing {
                        consumer.pop_slice(&mut scratch[..n])
                    } else {
                        0
                    };

                    for i in 0..n {
                        let value = if i < popped {
                            scratch[i] * volume
                        } else {
                            0.0
                        };
                        data[offset + i] = T::from_sample(value);
                    }

                    popped_total += popped;
                    offset += n;
                }

                if playing {
                    if popped_total < data.len() {
                        shared.underruns.fetch_add(1, Ordering::Relaxed);
                    }
                    let frames = popped_total / out_channels.max(1);
                    shared
                        .played_samples
                        .fetch_add(frames as u64, Ordering::Relaxed);
                }
            },
            move |err| {
                eprintln!("audio stream error: {err}");
                if let Ok(mut meta) = err_shared.meta.lock() {
                    meta.error = Some(format!("输出流错误: {err}"));
                }
            },
            None,
        )
        .map_err(|e| format!("无法创建输出流: {e}"))
}

struct Output {
    producer: HeapProd<f32>,
    _stream: cpal::Stream,
}

fn create_output(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Shared>,
) -> Result<Output, String> {
    let capacity = (config.sample_rate.0 as usize * config.channels as usize * RING_SECONDS)
        .max(8192);
    let ring = HeapRb::<f32>::new(capacity);
    let (producer, consumer) = ring.split();

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(device, config, consumer, shared)?,
        SampleFormat::I16 => build_stream::<i16>(device, config, consumer, shared)?,
        SampleFormat::U16 => build_stream::<u16>(device, config, consumer, shared)?,
        SampleFormat::F64 => build_stream::<f64>(device, config, consumer, shared)?,
        SampleFormat::I32 => build_stream::<i32>(device, config, consumer, shared)?,
        other => return Err(format!("暂不支持设备采样格式 {other:?}")),
    };

    stream.play().map_err(|e| format!("无法启动输出流: {e}"))?;
    Ok(Output {
        producer,
        _stream: stream,
    })
}

fn worker_loop<F>(rx: Receiver<Command>, shared: Arc<Shared>, on_state: F)
where
    F: Fn(PlayerSnapshot),
{
    let host = cpal::default_host();
    let setup = match host.default_output_device() {
        Some(device) => match device.default_output_config() {
            Ok(supported) => {
                let config: StreamConfig = supported.config();
                let sample_format = supported.sample_format();
                let device_name = device.name().unwrap_or_else(|_| "未知设备".to_string());
                {
                    let mut meta = shared.meta.lock().expect("player meta poisoned");
                    meta.device = device_name;
                    meta.output_mode = "WASAPI 共享".to_string();
                    meta.output_rate = config.sample_rate.0;
                    meta.output_channels = config.channels as usize;
                }
                Some((device, config, sample_format))
            }
            Err(e) => {
                set_error(&shared, format!("无法获取默认输出格式: {e}"));
                None
            }
        },
        None => {
            set_error(&shared, "系统没有默认输出设备".to_string());
            None
        }
    };

    let (out_rate, out_channels) = setup
        .as_ref()
        .map(|(_, config, _)| (config.sample_rate.0, config.channels as usize))
        .unwrap_or((48000, 2));

    let mut session: Option<Session> = None;
    let mut output: Option<Output> = None;
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    loop {
        let mut changed = false;

        while let Ok(command) = rx.try_recv() {
            changed = true;
            match command {
                Command::Load(path) => {
                    shared.playing.store(false, Ordering::Relaxed);
                    output = None;
                    shared.played_samples.store(0, Ordering::Relaxed);
                    shared.set_base(0.0);
                    session = None;

                    match Session::open(&path, out_rate, out_channels) {
                        Ok((new_session, info)) => {
                            if let Ok(mut meta) = shared.meta.lock() {
                                meta.loaded = true;
                                meta.title = info.title;
                                meta.path = path.to_string_lossy().to_string();
                                meta.codec = info.codec;
                                meta.sample_rate = info.sample_rate;
                                meta.bits = info.bits;
                                meta.channels = info.channels;
                                meta.duration = info.duration;
                                meta.error = None;
                            }
                            session = Some(new_session);

                            if let Some((device, config, format)) = setup.as_ref() {
                                match create_output(
                                    device,
                                    config,
                                    *format,
                                    Arc::clone(&shared),
                                ) {
                                    Ok(new_output) => {
                                        output = Some(new_output);
                                        shared.playing.store(true, Ordering::Relaxed);
                                    }
                                    Err(e) => set_error(&shared, e),
                                }
                            } else {
                                set_error(&shared, "没有可用的输出设备".to_string());
                            }
                        }
                        Err(e) => {
                            if let Ok(mut meta) = shared.meta.lock() {
                                meta.loaded = false;
                                meta.title.clear();
                                meta.path.clear();
                                meta.error = Some(e.clone());
                            }
                            set_error(&shared, e);
                        }
                    }
                }
                Command::Play => {
                    // 只有“解码到头、缓冲已空、位置确实在末尾”才算播完；
                    // 暂停期间预读填满缓冲也会 finished=true，不能据此重头播放
                    let at_end = {
                        let snap = shared.snapshot();
                        session.as_ref().map(|s| s.finished).unwrap_or(false)
                            && output
                                .as_ref()
                                .map(|o| o.producer.occupied_len() == 0)
                                .unwrap_or(true)
                            && snap.duration > 0.0
                            && snap.position >= snap.duration - 0.1
                    };
                    if at_end {
                        if let Some(s) = session.as_mut() {
                            if s.seek(0.0).is_ok() {
                                shared.played_samples.store(0, Ordering::Relaxed);
                                shared.set_base(0.0);
                                output = None;
                                if let Some((device, config, format)) = setup.as_ref() {
                                    if let Ok(new_output) =
                                        create_output(device, config, *format, Arc::clone(&shared))
                                    {
                                        output = Some(new_output);
                                    }
                                }
                            }
                        }
                    }
                    if session.is_some() && output.is_some() {
                        shared.playing.store(true, Ordering::Relaxed);
                    }
                }
                Command::Pause => shared.playing.store(false, Ordering::Relaxed),
                Command::Seek(secs) => {
                    if let Some(s) = session.as_mut() {
                        let was_playing = shared.playing.load(Ordering::Relaxed);
                        shared.playing.store(false, Ordering::Relaxed);
                        match s.seek(secs) {
                            Ok(()) => {
                                shared.played_samples.store(0, Ordering::Relaxed);
                                shared.set_base(secs.max(0.0));
                                output = None;
                                if let Some((device, config, format)) = setup.as_ref() {
                                    match create_output(
                                        device,
                                        config,
                                        *format,
                                        Arc::clone(&shared),
                                    ) {
                                        Ok(new_output) => {
                                            output = Some(new_output);
                                            shared
                                                .playing
                                                .store(was_playing, Ordering::Relaxed);
                                        }
                                        Err(e) => set_error(&shared, e),
                                    }
                                }
                            }
                            Err(e) => set_error(&shared, e),
                        }
                    }
                }
                Command::SetVolume(volume) => {
                    shared
                        .volume_bits
                        .store(volume.to_bits(), Ordering::Relaxed);
                }
            }
        }

        if let (Some(session), Some(output_ref)) = (session.as_mut(), output.as_mut()) {
            let producer_ref = &mut output_ref.producer;
            if !session.pending.is_empty() {
                let pushed = producer_ref.push_slice(&session.pending);
                if pushed > 0 {
                    session.pending.drain(..pushed);
                }
            }

            let free = producer_ref.vacant_len();
            if !session.finished
                && session.pending.len() < PREFETCH_THRESHOLD
                && free >= PREFETCH_THRESHOLD
            {
                if let Err(e) = session.decode_next() {
                    set_error(&shared, e);
                    session.finished = true;
                }
            }

            if session.finished
                && session.pending.is_empty()
                && producer_ref.occupied_len() == 0
                && shared.playing.load(Ordering::Relaxed)
            {
                shared.playing.store(false, Ordering::Relaxed);
                let duration = shared
                    .meta
                    .lock()
                    .map(|m| m.duration)
                    .unwrap_or(0.0);
                shared.set_base(duration);
                shared.played_samples.store(0, Ordering::Relaxed);
            }
        }

        if changed || last_emit.elapsed() >= Duration::from_millis(200) {
            on_state(shared.snapshot());
            last_emit = Instant::now();
        }

        thread::sleep(Duration::from_millis(2));
    }
}
