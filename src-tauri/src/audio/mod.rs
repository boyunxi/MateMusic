mod tempo;
mod wasapi_exclusive;

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
use rubato::{
    Resampler as RubatoResampler, SincFixedIn, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use tempo::{TimeStretcher, MAX_SPEED, MIN_SPEED};
use wasapi_exclusive::ExclusiveHandle;

const RING_SECONDS: usize = 2;
const PREFETCH_THRESHOLD: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputMode {
    Exclusive,
    Shared,
}

impl OutputMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "exclusive" => Some(Self::Exclusive),
            "shared" => Some(Self::Shared),
            _ => None,
        }
    }
}

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
    pub output_format: String,
    pub device: String,
    pub underruns: u64,
    pub finished: bool,
    pub segment_start: f64,
    pub speed: f32,
    pub volume: f32,
    pub output_bits: Option<u32>,
    pub bit_perfect: bool,
    pub bit_perfect_verdict: String,
    pub bit_perfect_reasons: Vec<String>,
    pub error: Option<String>,
    pub note: Option<String>,
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
    output_format: String,
    output_bits: Option<u32>,
    exclusive: bool,
    device: String,
    error: Option<String>,
    note: Option<String>,
    segment_start: f64,
}

pub(crate) struct Shared {
    meta: Mutex<Meta>,
    pub(crate) playing: AtomicBool,
    pub(crate) played_samples: AtomicU64,
    pub(crate) exclusive_base: AtomicU64,
    base_secs: AtomicU64,
    pub(crate) volume_bits: AtomicU32,
    pub(crate) speed_bits: AtomicU32,
    pub(crate) underruns: AtomicU64,
    finished: AtomicBool,
    output_failed: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            meta: Mutex::new(Meta::default()),
            playing: AtomicBool::new(false),
            played_samples: AtomicU64::new(0),
            exclusive_base: AtomicU64::new(0),
            base_secs: AtomicU64::new(0.0f64.to_bits()),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            speed_bits: AtomicU32::new(1.0f32.to_bits()),
            underruns: AtomicU64::new(0),
            finished: AtomicBool::new(false),
            output_failed: AtomicBool::new(false),
        }
    }

    fn set_base(&self, secs: f64) {
        self.base_secs.store(secs.to_bits(), Ordering::Relaxed);
    }

    fn base(&self) -> f64 {
        f64::from_bits(self.base_secs.load(Ordering::Relaxed))
    }

    fn speed(&self) -> f32 {
        f32::from_bits(self.speed_bits.load(Ordering::Relaxed))
    }

    fn set_speed(&self, speed: f32) {
        let speed = if speed.is_finite() {
            speed.clamp(MIN_SPEED, MAX_SPEED)
        } else {
            1.0
        };
        self.speed_bits.store(speed.to_bits(), Ordering::Relaxed);
    }

    pub(crate) fn report_error(&self, message: String) {
        eprintln!("audio error: {message}");
        if let Ok(mut meta) = self.meta.lock() {
            meta.error = Some(message);
        }
    }

    pub(crate) fn mark_output_failed(&self) {
        self.output_failed.store(true, Ordering::Relaxed);
    }

    fn report_note(&self, message: String) {
        if let Ok(mut meta) = self.meta.lock() {
            meta.note = Some(message);
        }
    }

    fn snapshot(&self) -> PlayerSnapshot {
        let meta = self.meta.lock().expect("player meta poisoned");
        // played_samples 记录的是输出帧数；倍速下按 speed 映射回源时间轴
        let speed = self.speed();
        let played = self.played_samples.load(Ordering::Relaxed) as f64
            / (meta.output_rate.max(1) as f64)
            * speed as f64;
        let mut position = self.base() + played;
        if meta.duration > 0.0 {
            position = position.min(meta.duration);
        }
        let volume = f32::from_bits(self.volume_bits.load(Ordering::Relaxed));
        let loaded = meta.loaded && meta.error.is_none();
        let (bit_perfect, bit_perfect_verdict, reasons) = evaluate_bit_perfect(
            loaded,
            &meta,
            speed,
            volume,
        );

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
            output_format: meta.output_format.clone(),
            device: meta.device.clone(),
            underruns: self.underruns.load(Ordering::Relaxed),
            finished: self.finished.load(Ordering::Relaxed),
            segment_start: meta.segment_start,
            speed,
            volume,
            output_bits: meta.output_bits,
            bit_perfect,
            bit_perfect_verdict: bit_perfect_verdict.to_string(),
            bit_perfect_reasons: reasons,
            error: meta.error.clone(),
            note: meta.note.clone(),
        }
    }
}

fn evaluate_bit_perfect(
    loaded: bool,
    meta: &Meta,
    speed: f32,
    volume: f32,
) -> (bool, &'static str, Vec<String>) {
    if !loaded {
        return (false, "idle", Vec::new());
    }

    let rate_match = meta.sample_rate > 0 && meta.sample_rate == meta.output_rate;
    let channels_match = meta.channels > 0 && meta.channels == meta.output_channels;
    let bits_match = meta
        .bits
        .zip(meta.output_bits)
        .map(|(source, output)| source == output)
        .unwrap_or(false);
    let dsp_active = (speed - 1.0).abs() > 1e-4 || (volume - 1.0).abs() > 1e-4;

    let mut reasons = Vec::new();
    if !meta.exclusive {
        reasons.push(if meta.output_mode.contains("共享") {
            "当前为 WASAPI 共享输出，系统混音参与".to_string()
        } else {
            "独占输出未生效".to_string()
        });
    }
    if !rate_match {
        reasons.push(format!(
            "采样率不一致：源 {} Hz / 输出 {} Hz",
            meta.sample_rate, meta.output_rate
        ));
    }
    if !channels_match {
        reasons.push(format!(
            "声道不一致：源 {} / 输出 {}",
            meta.channels, meta.output_channels
        ));
    }
    if !bits_match {
        match meta.bits {
            Some(source) => reasons.push(format!(
                "位深未保持：源 {} bit / 输出 {}",
                source,
                meta.output_bits
                    .map(|bits| format!("{bits} bit"))
                    .unwrap_or_else(|| "未知".to_string())
            )),
            None => reasons.push("源位深未知，无法验证位深保持".to_string()),
        }
    }
    if (speed - 1.0).abs() > 1e-4 {
        reasons.push(format!("倍速时间伸缩已启用（{}×）", speed));
    }
    if (volume - 1.0).abs() > 1e-4 {
        reasons.push(format!("音量处理未保持 100%（{:.0}%）", volume * 100.0));
    }

    let bit_perfect = meta.exclusive && rate_match && channels_match && bits_match && !dsp_active;
    let verdict = if bit_perfect {
        "bit-perfect"
    } else if !meta.exclusive {
        "unverifiable"
    } else {
        "not-bit-perfect"
    };
    (bit_perfect, verdict, reasons)
}

pub struct NextRequest {
    pub path: PathBuf,
    pub start: f64,
    pub end: Option<f64>,
}

enum Command {
    Load {
        path: PathBuf,
        start: f64,
        end: Option<f64>,
    },
    SetNext(Option<NextRequest>),
    Play,
    Pause,
    Seek(f64),
    SetVolume(f32),
    SetSpeed(f32),
    SetOutputMode(OutputMode),
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
        self.load_range(path, 0.0, None);
    }

    pub fn load_range(&self, path: PathBuf, start: f64, end: Option<f64>) {
        let _ = self.tx.send(Command::Load {
            path,
            start: start.max(0.0),
            end,
        });
    }

    pub fn set_next(&self, next: Option<NextRequest>) {
        let _ = self.tx.send(Command::SetNext(next));
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

    pub fn set_speed(&self, speed: f32) {
        let speed = if speed.is_finite() {
            speed.clamp(MIN_SPEED, MAX_SPEED)
        } else {
            1.0
        };
        let _ = self.tx.send(Command::SetSpeed(speed));
    }

    pub fn set_output_mode(&self, mode: OutputMode) {
        let _ = self.tx.send(Command::SetOutputMode(mode));
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.shared.snapshot()
    }

    pub fn simulate_output_failure(&self) {
        self.shared.output_failed.store(true, Ordering::Relaxed);
    }
}

pub fn diagnose_wasapi() -> Vec<String> {
    wasapi_exclusive::diagnose()
}

struct TrackInfo {
    title: String,
    codec: String,
    sample_rate: u32,
    bits: Option<u32>,
    channels: usize,
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
                    self.prev[c] =
                        Self::map_channel(frame, self.src_channels, self.out_channels, c);
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

const RESAMPLER_CHUNK_FRAMES: usize = 1024;

enum OutputResampler {
    Identity {
        src_channels: usize,
        out_channels: usize,
    },
    Sinc {
        inner: SincFixedIn<f32>,
        src_channels: usize,
        out_channels: usize,
        leftover: Vec<f32>,
    },
    Linear(LinearResampler),
}

impl OutputResampler {
    fn new(src_rate: u32, src_channels: usize, out_rate: u32, out_channels: usize) -> Self {
        let src_channels = src_channels.max(1);
        let out_channels = out_channels.max(1);
        if src_rate == out_rate {
            return Self::Identity {
                src_channels,
                out_channels,
            };
        }

        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.95,
            oversampling_factor: 256,
            interpolation: SincInterpolationType::Linear,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = out_rate as f64 / src_rate.max(1) as f64;
        match SincFixedIn::<f32>::new(ratio, 1.1, params, RESAMPLER_CHUNK_FRAMES, out_channels) {
            Ok(inner) => Self::Sinc {
                inner,
                src_channels,
                out_channels,
                leftover: Vec::new(),
            },
            Err(error) => {
                eprintln!("audio resampler: rubato init failed, falling back to linear: {error}");
                Self::Linear(LinearResampler::new(
                    src_rate,
                    src_channels,
                    out_rate,
                    out_channels,
                ))
            }
        }
    }

    fn reset(&mut self) {
        match self {
            Self::Identity { .. } => {}
            Self::Sinc {
                inner, leftover, ..
            } => {
                inner.reset();
                leftover.clear();
            }
            Self::Linear(linear) => linear.reset(),
        }
    }

    fn process(&mut self, interleaved: &[f32], out: &mut Vec<f32>) -> Result<(), String> {
        match self {
            Self::Identity {
                src_channels,
                out_channels,
            } => {
                let frames = interleaved.len() / (*src_channels).max(1);
                for frame_index in 0..frames {
                    let frame = &interleaved
                        [frame_index * *src_channels..(frame_index + 1) * *src_channels];
                    for channel in 0..*out_channels {
                        out.push(LinearResampler::map_channel(
                            frame,
                            *src_channels,
                            *out_channels,
                            channel,
                        ));
                    }
                }
                Ok(())
            }
            Self::Sinc {
                inner,
                src_channels,
                out_channels,
                leftover,
            } => {
                leftover.extend_from_slice(interleaved);
                let chunk_samples = RESAMPLER_CHUNK_FRAMES * *src_channels;
                while leftover.len() >= chunk_samples {
                    Self::process_chunk(
                        inner,
                        &leftover[..chunk_samples],
                        *src_channels,
                        *out_channels,
                        out,
                    )?;
                    leftover.drain(..chunk_samples);
                }
                Ok(())
            }
            Self::Linear(linear) => {
                linear.process(interleaved, out);
                Ok(())
            }
        }
    }

    fn flush(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        if let Self::Sinc {
            inner,
            src_channels,
            out_channels,
            leftover,
        } = self
        {
            if !leftover.is_empty() {
                let chunk_samples = RESAMPLER_CHUNK_FRAMES * *src_channels;
                leftover.resize(chunk_samples, 0.0);
                Self::process_chunk(
                    inner,
                    leftover.as_slice(),
                    *src_channels,
                    *out_channels,
                    out,
                )?;
                leftover.clear();
            }
        }
        Ok(())
    }

    fn process_chunk(
        inner: &mut SincFixedIn<f32>,
        interleaved: &[f32],
        src_channels: usize,
        out_channels: usize,
        out: &mut Vec<f32>,
    ) -> Result<(), String> {
        let mut planar: Vec<Vec<f32>> =
            vec![vec![0.0f32; RESAMPLER_CHUNK_FRAMES]; out_channels];
        for frame_index in 0..RESAMPLER_CHUNK_FRAMES {
            let frame = &interleaved
                [frame_index * src_channels..(frame_index + 1) * src_channels];
            for channel in 0..out_channels {
                planar[channel][frame_index] = LinearResampler::map_channel(
                    frame,
                    src_channels,
                    out_channels,
                    channel,
                );
            }
        }
        let waves = inner
            .process(&planar, None)
            .map_err(|e| format!("重采样失败: {e}"))?;
        let frames = waves.first().map(|wave| wave.len()).unwrap_or(0);
        for frame_index in 0..frames {
            for channel in 0..out_channels {
                out.push(
                    waves
                        .get(channel)
                        .and_then(|wave| wave.get(frame_index))
                        .copied()
                        .unwrap_or(0.0),
                );
            }
        }
        Ok(())
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

fn unsupported_message(path: &Path, detail: &str) -> String {
    match extension_of(path).as_str() {
        "ape" => {
            "缺少 APE 解码器：当前构建只启用 Symphonia，未包含 APE 解码器（未引入 FFmpeg）"
                .to_string()
        }
        "wma" => {
            "缺少 WMA 解码器：当前构建只启用 Symphonia，未包含 WMA 解码器（未引入 FFmpeg）"
                .to_string()
        }
        "opus" => {
            "缺少 Opus 解码器：当前构建未包含 Opus 解码器（未引入 FFmpeg），无法播放"
                .to_string()
        }
        "dsf" | "dff" => {
            "缺少 DSD 解码器：当前构建未包含 DSD 转 PCM 解码器（未引入 FFmpeg），暂不支持 DSF / DFF"
                .to_string()
        }
        _ => format!("无法识别容器格式：{detail}"),
    }
}

struct Session {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    src_rate: u32,
    src_channels: usize,
    src_bits: Option<u32>,
    resampler: OutputResampler,
    sample_buf: Option<SampleBuffer<f32>>,
    sample_spec: Option<(u32, usize)>,
    pending: Vec<f32>,
    finished: bool,
    file_duration: f64,
    segment_start: f64,
    segment_duration: f64,
    current_offset: f64,
    out_rate: u32,
    out_channels: usize,
    emitted_frames: u64,
    frames_limit: Option<u64>,
    speed: f32,
    tempo: TimeStretcher,
    tempo_out: Vec<f32>,
}

impl Session {
    fn open(path: &Path) -> Result<(Self, TrackInfo), String> {
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
            .map_err(|e| unsupported_message(path, &e.to_string()))?;

        let mut format = probed.format;
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
        let mut decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| {
                if matches!(
                    extension_of(path).as_str(),
                    "ape" | "wma" | "opus" | "dsf" | "dff"
                ) {
                    unsupported_message(path, &e.to_string())
                } else {
                    format!("缺少解码器: {e}")
                }
            })?;

        // MP4 等容器在参数里可能没有采样率/声道，先解一个包拿到真实规格再回到开头
        let (sample_rate, channels) = if sample_rate == 0 || channels == 0 {
            let mut probed_rate = sample_rate;
            let mut probed_channels = channels;
            if let Ok(packet) = format.next_packet() {
                if packet.track_id() == track_id {
                    if let Ok(audio_buf) = decoder.decode(&packet) {
                        let spec = *audio_buf.spec();
                        probed_rate = spec.rate;
                        probed_channels = spec.channels.count();
                    }
                }
            }
            let _ = format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::new(0, 0.0),
                    track_id: Some(track_id),
                },
            );
            decoder.reset();
            (probed_rate, probed_channels)
        } else {
            (sample_rate, channels)
        };

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

        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未知曲目")
            .to_string();

        let bits = params.bits_per_sample;
        let info = TrackInfo {
            title,
            codec,
            sample_rate,
            bits,
            channels,
        };

        let session = Self {
            format,
            decoder,
            track_id,
            src_rate: sample_rate,
            src_channels: channels,
            src_bits: bits,
            resampler: OutputResampler::new(sample_rate, channels, sample_rate, channels),
            sample_buf: None,
            sample_spec: None,
            pending: Vec::new(),
            finished: false,
            file_duration: duration,
            segment_start: 0.0,
            segment_duration: duration,
            current_offset: 0.0,
            out_rate: 0,
            out_channels: 0,
            emitted_frames: 0,
            frames_limit: None,
            speed: 1.0,
            tempo: TimeStretcher::new(channels, sample_rate, 1.0),
            tempo_out: Vec::new(),
        };

        Ok((session, info))
    }

    fn configure_output(&mut self, out_rate: u32, out_channels: usize) {
        self.resampler =
            OutputResampler::new(self.src_rate, self.src_channels, out_rate, out_channels);
        self.pending.clear();
        self.out_rate = out_rate;
        self.out_channels = out_channels.max(1);
        self.emitted_frames = 0;
        self.frames_limit = self.limit_for_offset(self.current_offset);
    }

    fn set_range(&mut self, start: f64, end: Option<f64>) {
        self.segment_start = start.max(0.0);
        self.segment_duration = match end {
            Some(end) => (end - self.segment_start).max(0.0),
            None => (self.file_duration - self.segment_start).max(0.0),
        };
        self.current_offset = 0.0;
        self.emitted_frames = 0;
        self.frames_limit = self.limit_for_offset(0.0);
    }

    fn limit_for_offset(&self, offset: f64) -> Option<u64> {
        if self.out_rate == 0 || self.segment_duration <= 0.0 {
            return None;
        }
        let remaining = (self.segment_duration - offset.max(0.0)).max(0.0);
        let speed = self.speed.max(0.01) as f64;
        Some((remaining / speed * self.out_rate as f64).round() as u64)
    }

    fn set_speed(&mut self, speed: f32) {
        self.speed = if speed.is_finite() {
            speed.clamp(MIN_SPEED, MAX_SPEED)
        } else {
            1.0
        };
        self.tempo.reset(self.speed);
        self.tempo_out.clear();
    }

    fn remaining_output_samples(&self) -> Option<usize> {
        self.frames_limit.map(|limit| {
            let remaining = limit.saturating_sub(self.emitted_frames);
            (remaining as usize).saturating_mul(self.out_channels.max(1))
        })
    }

    fn record_emitted(&mut self, samples: usize) {
        if samples == 0 {
            return;
        }
        self.emitted_frames += (samples / self.out_channels.max(1)) as u64;
        if let Some(limit) = self.frames_limit {
            if self.emitted_frames >= limit {
                self.finished = true;
                self.pending.clear();
            }
        }
    }

    fn seek(&mut self, secs: f64) -> Result<(), String> {
        let relative = secs.max(0.0);
        let absolute = self.segment_start + relative;
        let time = Time::new(absolute as u64, absolute.fract());
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
        self.tempo.reset(self.speed);
        self.tempo_out.clear();
        self.sample_buf = None;
        self.sample_spec = None;
        self.pending.clear();
        self.finished = false;
        self.current_offset = relative;
        self.emitted_frames = 0;
        self.frames_limit = self.limit_for_offset(relative);
        Ok(())
    }

    fn mark_finished(&mut self) -> Result<(), String> {
        if !self.finished {
            self.finished = true;
            if (self.speed - 1.0).abs() > 1e-4 {
                self.tempo_out.clear();
                self.tempo.flush(&mut self.tempo_out);
                if !self.tempo_out.is_empty() {
                    self.resampler
                        .process(&self.tempo_out, &mut self.pending)
                        .map_err(|error| format!("重采样失败: {error}"))?;
                }
            }
            self.resampler.flush(&mut self.pending)?;
        }
        Ok(())
    }

    fn prefill_output(&mut self, target_samples: usize) -> Result<(), String> {
        let mut guard = 0;
        while self.pending.len() < target_samples && !self.finished && guard < 8192 {
            self.decode_next()?;
            guard += 1;
        }
        Ok(())
    }

    fn decode_next(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }

        let packet = match self.format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => {
                return self.mark_finished();
            }
            Err(SymphoniaError::ResetRequired) => {
                return self.mark_finished();
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
                let buf = self
                    .sample_buf
                    .as_mut()
                    .expect("sample buffer initialized above");
                buf.copy_interleaved_ref(audio_buf);
                if (self.speed - 1.0).abs() <= 1e-4 {
                    self.resampler
                        .process(buf.samples(), &mut self.pending)
                        .map_err(|e| format!("重采样失败: {e}"))?;
                } else {
                    self.tempo_out.clear();
                    self.tempo.process(buf.samples(), &mut self.tempo_out);
                    if !self.tempo_out.is_empty() {
                        self.resampler
                            .process(&self.tempo_out, &mut self.pending)
                            .map_err(|e| format!("重采样失败: {e}"))?;
                    }
                }
            }
            Err(SymphoniaError::DecodeError(_)) => {}
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => {
                self.mark_finished()?;
            }
            Err(e) => return Err(format!("解码失败: {e}")),
        }

        Ok(())
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let out_channels = config.channels as usize;
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
                        match consumer.try_lock() {
                            Ok(mut guard) => guard.pop_slice(&mut scratch[..n]),
                            Err(_) => 0,
                        }
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
                err_shared.report_error(format!("共享输出流错误: {err}"));
                err_shared.mark_output_failed();
            },
            None,
        )
        .map_err(|e| format!("无法创建共享输出流: {e}"))
}

struct DeviceSetup {
    device: cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    name: String,
}

struct NextInfo {
    path: String,
    title: String,
    codec: String,
    sample_rate: u32,
    bits: Option<u32>,
    channels: usize,
    duration: f64,
    segment_start: f64,
}

struct Preloaded {
    session: Session,
    info: NextInfo,
}

struct Transition {
    at_frames: u64,
    info: NextInfo,
}

impl DeviceSetup {
    fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{:?}",
            self.name,
            self.config.sample_rate.0,
            self.config.channels,
            self.sample_format
        )
    }
}

struct ActiveOutput {
    producer: HeapProd<f32>,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    mode: OutputMode,
    _backend: Backend,
}

enum Backend {
    Shared { _stream: cpal::Stream },
    Exclusive { _handle: ExclusiveHandle },
}

fn make_ring(rate: u32, channels: usize) -> (HeapProd<f32>, Arc<Mutex<HeapCons<f32>>>) {
    let capacity = (rate as usize * channels.max(1) * RING_SECONDS).max(8192);
    let (producer, consumer) = HeapRb::<f32>::new(capacity).split();
    (producer, Arc::new(Mutex::new(consumer)))
}

fn sample_format_bits(format: SampleFormat) -> Option<u32> {
    match format {
        SampleFormat::F32 | SampleFormat::I32 | SampleFormat::U32 => Some(32),
        SampleFormat::F64 => Some(64),
        SampleFormat::I16 | SampleFormat::U16 => Some(16),
        _ => None,
    }
}

fn sample_format_label(format: SampleFormat) -> &'static str {
    match format {
        SampleFormat::F32 => "32 bit float",
        SampleFormat::F64 => "64 bit float",
        SampleFormat::I16 | SampleFormat::U16 => "16 bit",
        SampleFormat::I32 | SampleFormat::U32 => "32 bit",
        _ => "未知格式",
    }
}

fn create_active_output(
    pref: OutputMode,
    session: &mut Session,
    shared: &Arc<Shared>,
    setup: &DeviceSetup,
) -> Result<ActiveOutput, String> {
    shared.exclusive_base.store(0, Ordering::Relaxed);
    if pref == OutputMode::Exclusive {
        let (producer, consumer) = make_ring(session.src_rate, session.src_channels);
        match wasapi_exclusive::spawn(
            session.src_rate,
            session.src_channels,
            session.src_bits,
            Arc::clone(&consumer),
            Arc::clone(shared),
        ) {
            Ok((handle, negotiated)) => {
                session.configure_output(negotiated.rate, negotiated.channels);
                if let Ok(mut meta) = shared.meta.lock() {
                    meta.output_mode = "WASAPI 独占".to_string();
                    meta.output_rate = negotiated.rate;
                    meta.output_channels = negotiated.channels;
                    meta.output_format = negotiated.encoding.label().to_string();
                    meta.output_bits = Some(negotiated.encoding.valid_bits());
                    meta.exclusive = true;
                }
                eprintln!(
                    "audio output: exclusive {} Hz / {} ch / {}",
                    negotiated.rate,
                    negotiated.channels,
                    negotiated.encoding.label()
                );
                return Ok(ActiveOutput {
                    producer,
                    consumer,
                    mode: OutputMode::Exclusive,
                    _backend: Backend::Exclusive { _handle: handle },
                });
            }
            Err(e) => {
                eprintln!("audio output: 独占不可用，回退共享模式：{e}");
                shared.report_note("独占不可用，已回退 WASAPI 共享".to_string());
            }
        }
    }

    let mix_rate = setup.config.sample_rate.0;
    let mix_channels = setup.config.channels as usize;
    session.configure_output(mix_rate, mix_channels);
    let (producer, consumer) = make_ring(mix_rate, mix_channels);

    let stream = match setup.sample_format {
        SampleFormat::F32 => build_stream::<f32>(
            &setup.device,
            &setup.config,
            Arc::clone(&consumer),
            Arc::clone(shared),
        )?,
        SampleFormat::I16 => build_stream::<i16>(
            &setup.device,
            &setup.config,
            Arc::clone(&consumer),
            Arc::clone(shared),
        )?,
        SampleFormat::U16 => build_stream::<u16>(
            &setup.device,
            &setup.config,
            Arc::clone(&consumer),
            Arc::clone(shared),
        )?,
        SampleFormat::F64 => build_stream::<f64>(
            &setup.device,
            &setup.config,
            Arc::clone(&consumer),
            Arc::clone(shared),
        )?,
        SampleFormat::I32 => build_stream::<i32>(
            &setup.device,
            &setup.config,
            Arc::clone(&consumer),
            Arc::clone(shared),
        )?,
        other => return Err(format!("暂不支持设备采样格式 {other:?}")),
    };
    stream
        .play()
        .map_err(|e| format!("无法启动输出流: {e}"))?;

    if let Ok(mut meta) = shared.meta.lock() {
        meta.output_mode = "WASAPI 共享".to_string();
        meta.output_rate = mix_rate;
        meta.output_channels = mix_channels;
        meta.output_format = sample_format_label(setup.sample_format).to_string();
        meta.output_bits = sample_format_bits(setup.sample_format);
        meta.exclusive = false;
    }

    Ok(ActiveOutput {
        producer,
        consumer,
        mode: OutputMode::Shared,
        _backend: Backend::Shared { _stream: stream },
    })
}

fn query_device_setup(shared: &Shared) -> Option<DeviceSetup> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let supported = device.default_output_config().ok()?;
    let config: StreamConfig = supported.config();
    let sample_format = supported.sample_format();
    let name = device.name().unwrap_or_else(|_| "未知设备".to_string());
    if let Ok(mut meta) = shared.meta.lock() {
        meta.device = name.clone();
        meta.output_rate = config.sample_rate.0;
        meta.output_channels = config.channels as usize;
        meta.output_format = sample_format_label(sample_format).to_string();
    }
    Some(DeviceSetup {
        device,
        config,
        sample_format,
        name,
    })
}

fn worker_loop<F>(rx: Receiver<Command>, shared: Arc<Shared>, on_state: F)
where
    F: Fn(PlayerSnapshot),
{
    let mut setup = query_device_setup(&shared);
    let mut device_signature = setup
        .as_ref()
        .map(DeviceSetup::signature)
        .unwrap_or_default();
    let mut last_device_check = Instant::now();

    let mut session: Option<Session> = None;
    let mut output: Option<ActiveOutput> = None;
    let mut preloaded: Option<Preloaded> = None;
    let mut transition: Option<Transition> = None;
    let mut preferred_mode = OutputMode::Exclusive;
    let mut force_shared = false;
    let mut exclusive_guard: Option<(Instant, f64)> = None;
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    loop {
        let mut changed = false;

        if last_device_check.elapsed() >= Duration::from_secs(2) {
            last_device_check = Instant::now();
            let output_failed = shared.output_failed.swap(false, Ordering::Relaxed);
            let queried = query_device_setup(&shared);
            let signature = queried
                .as_ref()
                .map(DeviceSetup::signature)
                .unwrap_or_default();
            let needs_recovery = output_failed
                || signature != device_signature
                || (setup.is_none() && queried.is_some())
                || (session.is_some() && output.is_none());

            if needs_recovery {
                let previous_name = setup
                    .as_ref()
                    .map(|value| value.name.clone())
                    .unwrap_or_default();
                device_signature = signature;
                setup = queried;

                if let Some(session_ref) = session.as_mut() {
                    let snap = shared.snapshot();
                    let was_playing = snap.playing;
                    let position = snap.position;
                    shared.playing.store(false, Ordering::Relaxed);
                    output = None;
                    preloaded = None;
                    transition = None;
                    exclusive_guard = None;

                    if let Some(device_setup) = setup.as_ref() {
                        if session_ref.seek(position).is_ok() {
                            shared.played_samples.store(0, Ordering::Relaxed);
                            shared.set_base(position);
                            shared.finished.store(false, Ordering::Relaxed);
                            let effective = if force_shared {
                                OutputMode::Shared
                            } else {
                                preferred_mode
                            };
                            match create_active_output(
                                effective,
                                session_ref,
                                &shared,
                                device_setup,
                            ) {
                                Ok(new_output) => {
                                    if new_output.mode == OutputMode::Exclusive {
                                        exclusive_guard =
                                            Some((Instant::now(), shared.snapshot().position));
                                    }
                                    output = Some(new_output);
                                    shared.playing.store(was_playing, Ordering::Relaxed);
                                    if !previous_name.is_empty()
                                        && device_setup.name != previous_name
                                    {
                                        let suffix = if was_playing {
                                            "已自动恢复播放"
                                        } else {
                                            "已切换输出设备"
                                        };
                                        shared.report_note(format!(
                                            "输出设备已切换：{}，{suffix}",
                                            device_setup.name
                                        ));
                                    } else if output_failed {
                                        shared.report_note(format!(
                                            "输出设备异常，已重新打开：{}",
                                            device_setup.name
                                        ));
                                    }
                                }
                                Err(error) => shared
                                    .report_error(format!("重新打开输出设备失败: {error}")),
                            }
                        }
                    } else {
                        shared.report_note(
                            "输出设备已断开，等待重新连接…".to_string(),
                        );
                    }
                }
            }
        }

        while let Ok(command) = rx.try_recv() {
            changed = true;
            match command {
                Command::Load { path, start, end } => {
                    shared.playing.store(false, Ordering::Relaxed);
                    shared.finished.store(false, Ordering::Relaxed);
                    preloaded = None;
                    transition = None;
                    output = None;
                    force_shared = false;
                    exclusive_guard = None;
                    shared.played_samples.store(0, Ordering::Relaxed);
                    shared.set_base(0.0);
                    session = None;

                    match Session::open(&path) {
                        Ok((mut new_session, info)) => {
                            new_session.set_speed(shared.speed());
                            new_session.set_range(start, end);
                            if end.is_some() && new_session.segment_duration <= 0.0 {
                                let error = "分轨区间无效：结束时间必须大于开始时间".to_string();
                                shared.report_error(error.clone());
                                if let Ok(mut meta) = shared.meta.lock() {
                                    meta.loaded = false;
                                    meta.duration = 0.0;
                                    meta.error = Some(error);
                                }
                                continue;
                            }
                            if start > 0.0 {
                                if let Err(error) = new_session.seek(0.0) {
                                    shared.report_error(format!("分轨定位失败: {error}"));
                                    continue;
                                }
                            }
                            if let Ok(mut meta) = shared.meta.lock() {
                                meta.loaded = true;
                                meta.title = info.title;
                                meta.path = path.to_string_lossy().to_string();
                                meta.codec = info.codec;
                                meta.sample_rate = info.sample_rate;
                                meta.bits = info.bits;
                                meta.channels = info.channels;
                                meta.duration = new_session.segment_duration;
                                meta.segment_start = start.max(0.0);
                                meta.error = None;
                                meta.note = None;
                            }

                            let effective_mode = if force_shared {
                                OutputMode::Shared
                            } else {
                                preferred_mode
                            };
                            match setup.as_ref() {
                                Some(device_setup) => match create_active_output(
                                    effective_mode,
                                    &mut new_session,
                                    &shared,
                                    device_setup,
                                ) {
                                    Ok(new_output) => {
                                        if new_output.mode == OutputMode::Exclusive {
                                            exclusive_guard =
                                                Some((Instant::now(), shared.snapshot().position));
                                        }
                                        output = Some(new_output);
                                        shared.playing.store(true, Ordering::Relaxed);
                                    }
                                    Err(e) => shared.report_error(e),
                                },
                                None => {
                                    shared.report_error("没有可用的输出设备".to_string())
                                }
                            }

                            session = Some(new_session);
                        }
                        Err(e) => {
                            if let Ok(mut meta) = shared.meta.lock() {
                                meta.loaded = false;
                                meta.title.clear();
                                meta.path.clear();
                                meta.codec.clear();
                                meta.sample_rate = 0;
                                meta.bits = None;
                                meta.channels = 0;
                                meta.duration = 0.0;
                                meta.segment_start = 0.0;
                                meta.note = None;
                                meta.error = Some(e.clone());
                            }
                            shared.report_error(e);
                        }
                    }
                }
                Command::SetNext(next) => {
                    preloaded = None;
                    if let Some(request) = next {
                        let (out_rate, out_channels) = shared
                            .meta
                            .lock()
                            .map(|meta| (meta.output_rate, meta.output_channels))
                            .unwrap_or((0, 0));
                        if out_rate > 0 && out_channels > 0 && output.is_some() {
                            match Session::open(&request.path) {
                                Ok((mut next_session, info)) => {
                                    let start = request.start.max(0.0);
                                    next_session.set_speed(shared.speed());
                                    next_session.set_range(start, request.end);
                                    if start > 0.0 {
                                        if let Err(error) = next_session.seek(0.0) {
                                            eprintln!("gapless preload seek failed: {error}");
                                        }
                                    }
                                    next_session.configure_output(out_rate, out_channels);
                                    let target = out_rate as usize * out_channels.max(1) * 350 / 1000;
                                    if let Err(error) = next_session.prefill_output(target) {
                                        eprintln!("gapless prefill failed: {error}");
                                    }
                                    let duration = next_session.segment_duration;
                                    preloaded = Some(Preloaded {
                                        session: next_session,
                                        info: NextInfo {
                                            path: request
                                                .path
                                                .to_string_lossy()
                                                .to_string(),
                                            title: info.title,
                                            codec: info.codec,
                                            sample_rate: info.sample_rate,
                                            bits: info.bits,
                                            channels: info.channels,
                                            duration,
                                            segment_start: start,
                                        },
                                    });
                                }
                                Err(error) => {
                                    eprintln!("gapless preload failed: {error}");
                                }
                            }
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
                        if let (Some(s), Some(device_setup)) =
                            (session.as_mut(), setup.as_ref())
                        {
                            if s.seek(0.0).is_ok() {
                                shared.played_samples.store(0, Ordering::Relaxed);
                                shared.set_base(0.0);
                                shared.finished.store(false, Ordering::Relaxed);
                                output = None;
                                let effective_mode = if force_shared {
                                    OutputMode::Shared
                                } else {
                                    preferred_mode
                                };
                                match create_active_output(
                                    effective_mode,
                                    s,
                                    &shared,
                                    device_setup,
                                ) {
                                    Ok(new_output) => {
                                        if new_output.mode == OutputMode::Exclusive {
                                            exclusive_guard =
                                                Some((Instant::now(), shared.snapshot().position));
                                        }
                                        output = Some(new_output);
                                    }
                                    Err(e) => shared.report_error(e),
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
                        preloaded = None;
                        transition = None;
                        // 共享链路原地清空环形缓冲，不重建输出流，避免爆音与卡顿
                        let keep_shared = output
                            .as_ref()
                            .map(|out| out.mode == OutputMode::Shared)
                            .unwrap_or(false);
                        if keep_shared {
                            if let Some(out) = output.as_ref() {
                                if let Ok(mut consumer) = out.consumer.lock() {
                                    consumer.clear();
                                }
                            }
                        }
                        match s.seek(secs) {
                            Ok(()) => {
                                shared.played_samples.store(0, Ordering::Relaxed);
                                shared.set_base(secs.max(0.0));
                                shared.finished.store(false, Ordering::Relaxed);
                                exclusive_guard = None;
                                if keep_shared {
                                    shared.playing.store(was_playing, Ordering::Relaxed);
                                } else if let Some(device_setup) = setup.as_ref() {
                                    output = None;
                                    let effective_mode = if force_shared {
                                        OutputMode::Shared
                                    } else {
                                        preferred_mode
                                    };
                                    match create_active_output(
                                        effective_mode,
                                        s,
                                        &shared,
                                        device_setup,
                                    ) {
                                        Ok(new_output) => {
                                            if new_output.mode == OutputMode::Exclusive {
                                                exclusive_guard = Some((
                                                    Instant::now(),
                                                    shared.snapshot().position,
                                                ));
                                            }
                                            output = Some(new_output);
                                            shared.playing.store(was_playing, Ordering::Relaxed);
                                        }
                                        Err(e) => shared.report_error(e),
                                    }
                                } else {
                                    shared.report_note("输出设备不可用，已暂停播放".to_string());
                                }
                            }
                            Err(e) => shared.report_error(e),
                        }
                    }
                }
                Command::SetVolume(volume) => {
                    shared
                        .volume_bits
                        .store(volume.to_bits(), Ordering::Relaxed);
                }
                Command::SetSpeed(speed) => {
                    let snap = shared.snapshot();
                    shared.set_speed(speed);
                    preloaded = None;
                    transition = None;
                    exclusive_guard = None;
                    if let Some(session_ref) = session.as_mut() {
                        let was_playing = shared.playing.load(Ordering::Relaxed);
                        shared.playing.store(false, Ordering::Relaxed);
                        let exclusive = output
                            .as_ref()
                            .map(|out| out.mode == OutputMode::Exclusive)
                            .unwrap_or(false);
                        if exclusive {
                            let played = shared.played_samples.load(Ordering::Relaxed);
                            shared.exclusive_base.fetch_add(played, Ordering::Relaxed);
                        }
                        if let Some(out) = output.as_ref() {
                            if let Ok(mut consumer) = out.consumer.lock() {
                                consumer.clear();
                            }
                        }
                        session_ref.set_speed(speed);
                        match session_ref.seek(snap.position) {
                            Ok(()) => {
                                shared.played_samples.store(0, Ordering::Relaxed);
                                shared.set_base(snap.position);
                                shared.finished.store(false, Ordering::Relaxed);
                                shared.playing.store(was_playing, Ordering::Relaxed);
                            }
                            Err(error) => shared.report_error(error),
                        }
                    }
                }
                Command::SetOutputMode(mode) => {
                    preferred_mode = mode;
                    force_shared = mode == OutputMode::Shared;
                    exclusive_guard = None;
                    preloaded = None;
                    transition = None;
                    if let (Some(s), Some(device_setup)) = (session.as_mut(), setup.as_ref()) {
                        let snap = shared.snapshot();
                        let was_playing = shared.playing.load(Ordering::Relaxed);
                        shared.playing.store(false, Ordering::Relaxed);
                        if s.seek(snap.position).is_ok() {
                            shared.played_samples.store(0, Ordering::Relaxed);
                            shared.set_base(snap.position);
                            shared.finished.store(false, Ordering::Relaxed);
                            output = None;
                            match create_active_output(preferred_mode, s, &shared, device_setup)
                            {
                                Ok(new_output) => {
                                    if new_output.mode == OutputMode::Exclusive {
                                        exclusive_guard =
                                            Some((Instant::now(), shared.snapshot().position));
                                    }
                                    output = Some(new_output);
                                    shared.playing.store(was_playing, Ordering::Relaxed);
                                }
                                Err(e) => shared.report_error(e),
                            }
                        }
                    }
                }
            }
        }

        // 独占先尝试，若 900ms 内位置几乎没推进，判断为驱动不可用并回退共享
        if let Some((started_at, base_position)) = exclusive_guard {
            if started_at.elapsed() >= Duration::from_millis(900) {
                let snap = shared.snapshot();
                let advanced = snap.position - base_position;
                if snap.playing && advanced < 0.2 {
                    force_shared = true;
                    exclusive_guard = None;
                    if let (Some(s), Some(device_setup)) = (session.as_mut(), setup.as_ref()) {
                        let pos = snap.position;
                        let was_playing = shared.playing.load(Ordering::Relaxed);
                        shared.playing.store(false, Ordering::Relaxed);
                        if s.seek(pos).is_ok() {
                            shared.played_samples.store(0, Ordering::Relaxed);
                            shared.set_base(pos);
                            output = None;
                            match create_active_output(
                                OutputMode::Shared,
                                s,
                                &shared,
                                device_setup,
                            ) {
                                Ok(new_output) => {
                                    output = Some(new_output);
                                    shared.playing.store(was_playing, Ordering::Relaxed);
                                }
                                Err(e) => shared.report_error(e),
                            }
                            shared.report_note(
                                "独占输出未推进，已回退 WASAPI 共享".to_string(),
                            );
                        }
                    }
                } else {
                    exclusive_guard = None;
                }
            }
        }

        if let Some(pending) = transition.as_ref() {
            let played = shared.played_samples.load(Ordering::Relaxed);
            if played >= pending.at_frames {
                let pending = transition.take().expect("transition checked above");
                let remainder = played - pending.at_frames;
                let exclusive = output
                    .as_ref()
                    .map(|out| out.mode == OutputMode::Exclusive)
                    .unwrap_or(false);
                if exclusive {
                    shared
                        .exclusive_base
                        .fetch_add(pending.at_frames, Ordering::Relaxed);
                }
                shared.played_samples.store(remainder, Ordering::Relaxed);
                shared.set_base(0.0);
                shared.finished.store(false, Ordering::Relaxed);
                if let Ok(mut meta) = shared.meta.lock() {
                    meta.path = pending.info.path;
                    meta.title = pending.info.title;
                    meta.codec = pending.info.codec;
                    meta.sample_rate = pending.info.sample_rate;
                    meta.bits = pending.info.bits;
                    meta.channels = pending.info.channels;
                    meta.duration = pending.info.duration;
                    meta.segment_start = pending.info.segment_start;
                }
            }
        }

        if transition.is_none()
            && session
                .as_ref()
                .map(|session| session.finished && session.pending.is_empty())
                .unwrap_or(false)
        {
            if let Some(next) = preloaded.take() {
                let at_frames = session
                    .as_ref()
                    .map(|session| session.emitted_frames)
                    .unwrap_or(0);
                if at_frames > 0 {
                    session = Some(next.session);
                    transition = Some(Transition {
                        at_frames,
                        info: next.info,
                    });
                }
            }
        }

        if let (Some(session), Some(output_ref)) = (session.as_mut(), output.as_mut()) {
            let producer_ref = &mut output_ref.producer;
            if !session.pending.is_empty() {
                let max_samples = session.remaining_output_samples().unwrap_or(usize::MAX);
                let take = session.pending.len().min(max_samples);
                if take == 0 {
                    session.finished = true;
                    session.pending.clear();
                } else {
                    let pushed = producer_ref.push_slice(&session.pending[..take]);
                    if pushed > 0 {
                        session.pending.drain(..pushed);
                        session.record_emitted(pushed);
                    }
                }
            }

            let free = producer_ref.vacant_len();
            if !session.finished
                && session.pending.len() < PREFETCH_THRESHOLD
                && free >= PREFETCH_THRESHOLD
            {
                if let Err(e) = session.decode_next() {
                    shared.report_error(e);
                    session.finished = true;
                }
            }

            if session.finished
                && session.pending.is_empty()
                && producer_ref.occupied_len() == 0
                && transition.is_none()
                && shared.playing.load(Ordering::Relaxed)
            {
                shared.playing.store(false, Ordering::Relaxed);
                shared.finished.store(true, Ordering::Relaxed);
                let duration = shared.meta.lock().map(|m| m.duration).unwrap_or(0.0);
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

#[cfg(test)]
mod bitperfect_tests {
    use super::*;

    fn exclusive_meta() -> Meta {
        Meta {
            loaded: true,
            sample_rate: 44_100,
            output_rate: 44_100,
            channels: 2,
            output_channels: 2,
            bits: Some(16),
            output_bits: Some(16),
            exclusive: true,
            output_mode: "WASAPI 独占".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn exclusive_matching_format_is_bit_perfect() {
        let (perfect, verdict, reasons) =
            evaluate_bit_perfect(true, &exclusive_meta(), 1.0, 1.0);
        assert!(perfect);
        assert_eq!(verdict, "bit-perfect");
        assert!(reasons.is_empty());
    }

    #[test]
    fn shared_output_is_unverifiable() {
        let mut meta = exclusive_meta();
        meta.exclusive = false;
        meta.output_mode = "WASAPI 共享".to_string();
        let (perfect, verdict, reasons) = evaluate_bit_perfect(true, &meta, 1.0, 1.0);
        assert!(!perfect);
        assert_eq!(verdict, "unverifiable");
        assert!(reasons.iter().any(|reason| reason.contains("共享")));
    }

    #[test]
    fn resampling_or_dsp_blocks_bit_perfect() {
        let mut meta = exclusive_meta();
        meta.output_rate = 48_000;
        let (perfect, verdict, reasons) = evaluate_bit_perfect(true, &meta, 1.0, 1.0);
        assert!(!perfect);
        assert_eq!(verdict, "not-bit-perfect");
        assert!(reasons.iter().any(|reason| reason.contains("采样率")));

        let (perfect, _, reasons) = evaluate_bit_perfect(true, &exclusive_meta(), 1.25, 1.0);
        assert!(!perfect);
        assert!(reasons.iter().any(|reason| reason.contains("倍速")));

        let (perfect, _, reasons) = evaluate_bit_perfect(true, &exclusive_meta(), 1.0, 0.8);
        assert!(!perfect);
        assert!(reasons.iter().any(|reason| reason.contains("音量")));
    }

    #[test]
    fn unknown_source_bits_cannot_be_verified() {
        let mut meta = exclusive_meta();
        meta.bits = None;
        let (perfect, verdict, reasons) = evaluate_bit_perfect(true, &meta, 1.0, 1.0);
        assert!(!perfect);
        assert_eq!(verdict, "not-bit-perfect");
        assert!(reasons.iter().any(|reason| reason.contains("位深")));
    }
}
