use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use ringbuf::traits::Consumer;
use ringbuf::HeapCons;
use windows::core::GUID;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioClock, IAudioRenderClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_SHAREMODE_EXCLUSIVE,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use super::Shared;

const SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
const SUBTYPE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
// AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED：HD Audio 要求缓冲按 128 帧对齐
const BUFFER_SIZE_NOT_ALIGNED: u32 = 0x88890019;
const ALIGN_FRAMES: u32 = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    F32,
    I16,
    I24In32,
    I24,
}

impl Encoding {
    pub fn label(self) -> &'static str {
        match self {
            Encoding::F32 => "32 bit float",
            Encoding::I16 => "16 bit",
            Encoding::I24In32 | Encoding::I24 => "24 bit",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Negotiated {
    pub rate: u32,
    pub channels: usize,
    pub encoding: Encoding,
}

pub struct ExclusiveHandle {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for ExclusiveHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

struct Sink {
    client: IAudioClient,
    render: IAudioRenderClient,
    clock: IAudioClock,
    event: HANDLE,
    buffer_frames: u32,
    negotiated: Negotiated,
}

impl Sink {
    unsafe fn run(
        &mut self,
        consumer: &mut HeapCons<f32>,
        shared: &Shared,
        stop: &AtomicBool,
    ) {
        let channels = self.negotiated.channels;
        let mut scratch = vec![0.0f32; self.buffer_frames as usize * channels];

        // 独占播放前必须先把缓冲填满再 Start
        scratch.fill(0.0);
        if let Ok(ptr) = self.render.GetBuffer(self.buffer_frames) {
            write_samples(ptr, &scratch, self.negotiated.encoding, 1.0);
            let _ = self.render.ReleaseBuffer(self.buffer_frames, 0);
        }

        if let Err(e) = self.client.Start() {
            shared.report_error(format!("无法启动独占输出: {e}"));
            return;
        }

        let mut display_offset: u64 = 0;
        let mut paused_at: Option<u64> = None;

        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let playing = shared.playing.load(Ordering::Relaxed);
            if playing {
                if let Some(pause_clock) = paused_at.take() {
                    display_offset += clock_position(&self.clock).saturating_sub(pause_clock);
                }
            } else if paused_at.is_none() {
                paused_at = Some(clock_position(&self.clock));
            }

            if WaitForSingleObject(self.event, 50) != WAIT_OBJECT_0 {
                continue;
            }

            let padding = match self.client.GetCurrentPadding() {
                Ok(padding) => padding,
                Err(e) => {
                    shared.report_error(format!("独占输出读取缓冲失败: {e}"));
                    break;
                }
            };
            let available = self.buffer_frames.saturating_sub(padding);
            if available == 0 {
                continue;
            }

            let samples = available as usize * channels;
            scratch.resize(samples, 0.0);
            let popped = if playing {
                consumer.pop_slice(&mut scratch[..samples])
            } else {
                0
            };
            if playing {
                if popped < samples {
                    scratch[popped..samples].fill(0.0);
                    shared.underruns.fetch_add(1, Ordering::Relaxed);
                }
            } else {
                scratch[..samples].fill(0.0);
            }

            let volume = f32::from_bits(shared.volume_bits.load(Ordering::Relaxed));
            match self.render.GetBuffer(available) {
                Ok(ptr) => {
                    write_samples(ptr, &scratch, self.negotiated.encoding, volume);
                    if let Err(e) = self.render.ReleaseBuffer(available, 0) {
                        shared.report_error(format!("独占输出提交缓冲失败: {e}"));
                        break;
                    }
                }
                Err(e) => {
                    shared.report_error(format!("独占输出获取缓冲失败: {e}"));
                    break;
                }
            }

            if playing {
                // 独占模式用硬件时钟定位；暂停期间写静音但冻结显示位置
                let position = clock_position(&self.clock).saturating_sub(display_offset);
                shared
                    .played_samples
                    .store(position, Ordering::Relaxed);
            }
        }

        let _ = self.client.Stop();
    }
}

impl Drop for Sink {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

unsafe fn clock_position(clock: &IAudioClock) -> u64 {
    let mut position = 0u64;
    clock.GetPosition(&mut position, None).ok();
    position
}

fn channel_mask(channels: u16) -> u32 {
    match channels {
        1 => 0x4,
        2 => 0x3,
        4 => 0x33,
        6 => 0x3F,
        8 => 0x63F,
        _ => 0,
    }
}

fn build_format(rate: u32, channels: u16, encoding: Encoding) -> WAVEFORMATEXTENSIBLE {
    let (container_bits, valid_bits, subtype) = match encoding {
        Encoding::F32 => (32u16, 32u16, SUBTYPE_FLOAT),
        Encoding::I16 => (16, 16, SUBTYPE_PCM),
        Encoding::I24In32 => (32, 24, SUBTYPE_PCM),
        Encoding::I24 => (24, 24, SUBTYPE_PCM),
    };
    let block_align = channels * (container_bits / 8);

    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE,
            nChannels: channels,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: container_bits,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: valid_bits,
        },
        dwChannelMask: channel_mask(channels),
        SubFormat: subtype,
    }
}

fn candidate_encodings(source_bits: Option<u32>) -> Vec<Encoding> {
    match source_bits {
        Some(16) => vec![Encoding::I16],
        Some(24) => vec![Encoding::I24In32, Encoding::I24],
        Some(32) => vec![Encoding::I24In32],
        _ => vec![Encoding::I16, Encoding::I24In32],
    }
}

fn aligned_frames(period_hns: i64, rate: u32) -> u32 {
    let frames = ((rate as f64) * (period_hns as f64) / 10_000_000.0).ceil() as u32;
    frames.div_ceil(ALIGN_FRAMES) * ALIGN_FRAMES
}

fn frames_to_hns(frames: u32, rate: u32) -> i64 {
    ((10_000_000u64 * frames as u64 + rate as u64 - 1) / rate as u64) as i64
}

unsafe fn activate(device: &IMMDevice) -> Result<IAudioClient, String> {
    device
        .Activate(CLSCTX_ALL, None)
        .map_err(|e| format!("无法激活独占输出: {e}"))
}

unsafe fn finalize(
    client: IAudioClient,
    rate: u32,
    channels: usize,
    encoding: Encoding,
) -> Result<Sink, String> {
    let event = CreateEventW(None, false, false, None)
        .map_err(|e| format!("无法创建独占输出事件: {e}"))?;
    if let Err(e) = client.SetEventHandle(event) {
        let _ = CloseHandle(event);
        return Err(format!("无法绑定独占输出事件: {e}"));
    }

    let buffer_frames = match client.GetBufferSize() {
        Ok(size) => size,
        Err(e) => {
            let _ = CloseHandle(event);
            return Err(format!("无法获取独占输出缓冲大小: {e}"));
        }
    };
    let render: IAudioRenderClient = match client.GetService() {
        Ok(render) => render,
        Err(e) => {
            let _ = CloseHandle(event);
            return Err(format!("无法获取独占输出接口: {e}"));
        }
    };
    let clock: IAudioClock = match client.GetService() {
        Ok(clock) => clock,
        Err(e) => {
            let _ = CloseHandle(event);
            return Err(format!("无法获取独占输出时钟: {e}"));
        }
    };

    Ok(Sink {
        client,
        render,
        clock,
        event,
        buffer_frames,
        negotiated: Negotiated {
            rate,
            channels,
            encoding,
        },
    })
}

unsafe fn try_open(
    device: &IMMDevice,
    rate: u32,
    channels: usize,
    encoding: Encoding,
    period_hns: i64,
) -> Result<Sink, String> {
    let format = build_format(rate, channels as u16, encoding);

    let client = activate(device)?;
    let init = client.Initialize(
        AUDCLNT_SHAREMODE_EXCLUSIVE,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        period_hns,
        period_hns,
        std::ptr::addr_of!(format.Format),
        None,
    );

    match init {
        Ok(()) => finalize(client, rate, channels, encoding),
        Err(e) if e.code().0 as u32 == BUFFER_SIZE_NOT_ALIGNED => {
            let aligned = client
                .GetBufferSize()
                .ok()
                .filter(|size| *size > 0)
                .unwrap_or_else(|| aligned_frames(period_hns, rate));
            let aligned_hns = frames_to_hns(aligned, rate);
            let fresh = activate(device)?;
            fresh
                .Initialize(
                    AUDCLNT_SHAREMODE_EXCLUSIVE,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    aligned_hns,
                    aligned_hns,
                    std::ptr::addr_of!(format.Format),
                    None,
                )
                .map_err(|e| format!("独占格式对齐后仍失败 ({aligned} 帧): {e}"))?;
            finalize(fresh, rate, channels, encoding)
        }
        Err(e) => Err(format!(
            "{rate} Hz / {channels} ch / {}: {e}",
            encoding.label()
        )),
    }
}

unsafe fn open_sink(rate: u32, channels: usize, bits: Option<u32>) -> Result<Sink, String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("无法创建音频设备枚举器: {e}"))?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("无法获取默认输出设备: {e}"))?;

    let probe = activate(&device)?;
    let mut default_period = 0i64;
    let mut min_period = 0i64;
    probe
        .GetDevicePeriod(Some(&mut default_period), Some(&mut min_period))
        .map_err(|e| format!("无法获取设备周期: {e}"))?;
    let period = if default_period > 0 {
        default_period
    } else if min_period > 0 {
        min_period
    } else {
        106_667
    };

    let mut last_error = String::new();
    for encoding in candidate_encodings(bits) {
        match try_open(&device, rate, channels, encoding, period) {
            Ok(sink) => return Ok(sink),
            Err(e) => last_error = e,
        }
    }

    Err(if last_error.is_empty() {
        "设备不支持独占输出".to_string()
    } else {
        format!("设备拒绝独占格式：{last_error}")
    })
}

fn render_thread(
    rate: u32,
    channels: usize,
    bits: Option<u32>,
    mut consumer: HeapCons<f32>,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    ready: Sender<Result<Negotiated, String>>,
) {
    let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();

    match unsafe { open_sink(rate, channels, bits) } {
        Ok(mut sink) => {
            let negotiated = sink.negotiated;
            if ready.send(Ok(negotiated)).is_ok() {
                unsafe { sink.run(&mut consumer, &shared, &stop) };
            }
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }

    if com_initialized {
        unsafe { CoUninitialize() };
    }
}

pub fn spawn(
    rate: u32,
    channels: usize,
    bits: Option<u32>,
    consumer: HeapCons<f32>,
    shared: Arc<Shared>,
) -> Result<(ExclusiveHandle, Negotiated), String> {
    let (tx, rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);

    let join = thread::Builder::new()
        .name("matemusic-wasapi-exclusive".to_string())
        .spawn(move || render_thread(rate, channels, bits, consumer, shared, stop_thread, tx))
        .map_err(|e| format!("无法创建独占输出线程: {e}"))?;

    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(negotiated)) => Ok((
            ExclusiveHandle {
                stop,
                join: Some(join),
            },
            negotiated,
        )),
        Ok(Err(e)) => {
            stop.store(true, Ordering::Relaxed);
            let _ = join.join();
            Err(e)
        }
        Err(e) => {
            stop.store(true, Ordering::Relaxed);
            let _ = join.join();
            Err(format!("独占输出初始化超时: {e}"))
        }
    }
}

pub fn diagnose() -> Vec<String> {
    let mut lines = Vec::new();
    unsafe {
        let com = CoInitializeEx(None, COINIT_MULTITHREADED);
        lines.push(format!("CoInitializeEx(MTA) -> {com:?}"));

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(value) => value,
                Err(e) => {
                    lines.push(format!("创建枚举器失败: {e}"));
                    return lines;
                }
            };
        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(value) => value,
            Err(e) => {
                lines.push(format!("获取默认设备失败: {e}"));
                return lines;
            }
        };
        let client = match activate(&device) {
            Ok(value) => value,
            Err(e) => {
                lines.push(e);
                return lines;
            }
        };

        if let Ok(ptr) = client.GetMixFormat() {
            let mix = std::ptr::read_unaligned(ptr);
            let tag = mix.wFormatTag;
            let channels = mix.nChannels;
            let rate = mix.nSamplesPerSec;
            let bits = mix.wBitsPerSample;
            lines.push(format!(
                "mix format: tag=0x{tag:X} ch={channels} rate={rate} bits={bits}"
            ));
            CoTaskMemFree(Some(ptr as *const _));
        }

        for rate in [44100u32, 48000, 96000] {
            for encoding in [Encoding::I16, Encoding::I24In32, Encoding::F32] {
                let format = build_format(rate, 2, encoding);
                let hr = client.IsFormatSupported(
                    AUDCLNT_SHAREMODE_EXCLUSIVE,
                    std::ptr::addr_of!(format.Format),
                    None,
                );
                lines.push(format!(
                    "IsFormatSupported(EXCLUSIVE, {rate} Hz / 2 ch / {}) -> 0x{:08X}",
                    encoding.label(),
                    hr.0 as u32
                ));
            }
        }

        for (rate, bits) in [(44100u32, 16u32), (48000, 24), (96000, 24)] {
            match open_sink(rate, 2, Some(bits)) {
                Ok(sink) => lines.push(format!(
                    "open exclusive {rate} Hz / {bits} bit -> {} buffer={} frames",
                    sink.negotiated.encoding.label(),
                    sink.buffer_frames
                )),
                Err(e) => lines.push(format!("open exclusive {rate} Hz / {bits} bit -> {e}")),
            }
        }
    }

    unsafe { CoUninitialize() };
    lines
}

unsafe fn write_samples(ptr: *mut u8, samples: &[f32], encoding: Encoding, volume: f32) {
    match encoding {
        Encoding::F32 => {
            let dst = std::slice::from_raw_parts_mut(ptr as *mut f32, samples.len());
            for (slot, sample) in dst.iter_mut().zip(samples) {
                *slot = sample * volume;
            }
        }
        Encoding::I16 => {
            let dst = std::slice::from_raw_parts_mut(ptr as *mut i16, samples.len());
            for (slot, sample) in dst.iter_mut().zip(samples) {
                *slot = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            }
        }
        Encoding::I24In32 => {
            let dst = std::slice::from_raw_parts_mut(ptr as *mut i32, samples.len());
            for (slot, sample) in dst.iter_mut().zip(samples) {
                let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0) as i32;
                *slot = value << 8;
            }
        }
        Encoding::I24 => {
            for (i, sample) in samples.iter().enumerate() {
                let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0) as i32;
                let bytes = value.to_le_bytes();
                let base = ptr.add(i * 3);
                *base = bytes[0];
                *base.add(1) = bytes[1];
                *base.add(2) = bytes[2];
            }
        }
    }
}
