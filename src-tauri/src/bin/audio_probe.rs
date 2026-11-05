use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
use matemusic_lib::audio::{AudioEngine, OutputMode};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

type Result<T> = std::result::Result<T, String>;

struct Decoded {
    interleaved: Vec<f32>,
    sample_rate: u32,
    channels: usize,
    bits_per_sample: Option<u32>,
    codec: String,
    frames: u64,
    peak: f32,
}

impl Decoded {
    fn duration_secs(&self) -> f64 {
        self.frames as f64 / self.sample_rate as f64
    }
}

fn decode(path: &Path) -> Result<Decoded> {
    let file = File::open(path).map_err(|e| format!("无法打开文件 {}: {e}", path.display()))?;
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

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "文件里没有可播放的默认音轨".to_string())?;
    let track_id = track.id;
    let params = track.codec_params.clone();

    let codec = symphonia::default::get_codecs()
        .get_codec(params.codec)
        .map(|d| format!("{} ({})", d.short_name, d.long_name))
        .unwrap_or_else(|| format!("codec#{}", params.codec));

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("无法创建解码器: {e}"))?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut channels = params.channels.map(|c| c.count()).unwrap_or(0);
    let mut peak = 0.0f32;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("读取数据包失败: {e}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                let spec = *audio_buf.spec();
                sample_rate = spec.rate;
                channels = spec.channels.count();

                if sample_buf.is_none() {
                    sample_buf = Some(SampleBuffer::<f32>::new(
                        audio_buf.capacity() as u64,
                        spec,
                    ));
                }
                let sb = sample_buf.as_mut().expect("sample buffer initialized above");
                sb.copy_interleaved_ref(audio_buf);

                for &s in sb.samples() {
                    peak = peak.max(s.abs());
                    interleaved.push(s);
                }
            }
            // 单包损坏不应中断整首曲目
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("解码失败: {e}")),
        }
    }

    if channels == 0 || sample_rate == 0 {
        return Err("解码结果缺少采样率或声道信息".to_string());
    }

    let frames = (interleaved.len() / channels) as u64;

    Ok(Decoded {
        interleaved,
        sample_rate,
        channels,
        bits_per_sample: params.bits_per_sample,
        codec,
        frames,
        peak,
    })
}

fn probe(path: &Path) -> Result<()> {
    let d = decode(path)?;
    let peak_db = if d.peak > 0.0 {
        20.0 * d.peak.log10()
    } else {
        f32::NEG_INFINITY
    };

    println!("file           {}", path.display());
    println!("codec          {}", d.codec);
    println!("sample rate    {} Hz", d.sample_rate);
    println!("channels       {}", d.channels);
    println!(
        "bit depth      {}",
        d.bits_per_sample
            .map(|b| format!("{b} bit"))
            .unwrap_or_else(|| "未知".to_string())
    );
    println!("duration       {:.3} s", d.duration_secs());
    println!("decoded frames {}", d.frames);
    println!("peak           {:.1} dBFS", peak_db);
    Ok(())
}

struct PlaySource {
    interleaved: Vec<f32>,
    src_channels: usize,
    src_rate: u32,
    done: Arc<AtomicBool>,
}

#[allow(clippy::too_many_arguments)]
fn mapped_sample(
    src: &[f32],
    src_channels: usize,
    src_frames: usize,
    frame_a: usize,
    frame_b: usize,
    out_channel: usize,
    out_channels: usize,
    frac: f32,
) -> f32 {
    let at = |frame: usize| -> f32 {
        if frame >= src_frames {
            return 0.0;
        }
        let base = frame * src_channels;
        if src_channels == 1 {
            return src[base];
        }
        if out_channels == 1 {
            let sum: f32 = src[base..base + src_channels].iter().sum();
            return sum / src_channels as f32;
        }
        if out_channel < src_channels {
            src[base + out_channel]
        } else {
            0.0
        }
    };
    let a = at(frame_a);
    let b = at(frame_b);
    a + (b - a) * frac
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    source: Arc<PlaySource>,
) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let out_channels = config.channels as usize;
    let out_rate = config.sample_rate.0 as f64;
    let ratio = source.src_rate as f64 / out_rate;
    let src_frames = source.interleaved.len() / source.src_channels;
    let mut pos = 0.0f64;

    let err_source = source.clone();
    let done = source.done.clone();

    let stream = device
        .build_output_stream(
            config,
            move |out: &mut [T], _| {
                let frames = out.len() / out_channels.max(1);
                for f in 0..frames {
                    let frame_a = pos as usize;
                    let frac = (pos - frame_a as f64) as f32;

                    if frame_a >= src_frames {
                        for c in 0..out_channels {
                            out[f * out_channels + c] = T::from_sample(0.0f32);
                        }
                        done.store(true, Ordering::Relaxed);
                        continue;
                    }

                    for c in 0..out_channels {
                        let v = mapped_sample(
                            &source.interleaved,
                            source.src_channels,
                            src_frames,
                            frame_a,
                            frame_a + 1,
                            c,
                            out_channels,
                            frac,
                        );
                        out[f * out_channels + c] = T::from_sample(v);
                    }
                    pos += ratio;
                }
            },
            move |err| {
                eprintln!("输出流错误: {err}");
                err_source.done.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| format!("无法创建输出流 (格式 {sample_format:?}): {e}"))?;

    stream.play().map_err(|e| format!("无法启动输出流: {e}"))?;
    Ok(stream)
}

fn play(path: &Path) -> Result<()> {
    let d = decode(path)?;
    let seconds = d.duration_secs();

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "系统没有默认输出设备".to_string())?;
    let device_name = device.name().unwrap_or_else(|_| "未知设备".to_string());
    let supported = device
        .default_output_config()
        .map_err(|e| format!("无法获取默认输出格式: {e}"))?;

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.config();

    println!("source         {} Hz / {} ch / {} bit", d.sample_rate, d.channels, d.bits_per_sample.map(|b| b.to_string()).unwrap_or_else(|| "?".into()));
    println!("device         {device_name}");
    println!(
        "device format  {} Hz / {} ch / {:?}",
        config.sample_rate.0, config.channels, sample_format
    );
    println!("mode           WASAPI 共享（非 Bit-Perfect，系统混音参与）");

    if config.sample_rate.0 != d.sample_rate || config.channels as usize != d.channels {
        println!(
            "resample       linear {} Hz -> {} Hz / {} ch -> {} ch（spike 阶段临时实现）",
            d.sample_rate, config.sample_rate.0, d.channels, config.channels
        );
    } else {
        println!("resample       无（源格式与设备混音格式一致）");
    }

    let source = Arc::new(PlaySource {
        interleaved: d.interleaved,
        src_channels: d.channels,
        src_rate: d.sample_rate,
        done: Arc::new(AtomicBool::new(false)),
    });

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, sample_format, source.clone())?,
        SampleFormat::I16 => build_stream::<i16>(&device, &config, sample_format, source.clone())?,
        SampleFormat::U16 => build_stream::<u16>(&device, &config, sample_format, source.clone())?,
        SampleFormat::F64 => build_stream::<f64>(&device, &config, sample_format, source.clone())?,
        SampleFormat::I32 => build_stream::<i32>(&device, &config, sample_format, source.clone())?,
        other => return Err(format!("暂不支持设备采样格式 {other:?}")),
    };

    println!("playing        {:.3} s", seconds);
    let deadline = std::time::Instant::now() + Duration::from_secs_f64(seconds + 1.0);
    while std::time::Instant::now() < deadline && !source.done.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);

    if source.done.load(Ordering::Relaxed) {
        println!("done           播放结束");
    } else {
        println!("done           达到时长上限，已停止");
    }
    Ok(())
}

fn engine_check(path: &Path) -> Result<()> {
    let engine = AudioEngine::spawn(|snapshot| {
        if let Some(err) = snapshot.error {
            eprintln!("engine state error: {err}");
        }
    });

    engine.set_volume(0.35);
    engine.load(path.to_path_buf());
    std::thread::sleep(Duration::from_millis(1700));
    let loaded = engine.snapshot();
    println!(
        "loaded={} playing={} pos={:.3} dur={:.3} codec={} {} Hz/{} ch mode={} out={}Hz/{}ch/{} underruns={} note={:?}",
        loaded.loaded,
        loaded.playing,
        loaded.position,
        loaded.duration,
        loaded.codec,
        loaded.sample_rate,
        loaded.channels,
        loaded.output_mode,
        loaded.output_rate,
        loaded.output_channels,
        loaded.output_format,
        loaded.underruns,
        loaded.note
    );
    if !loaded.loaded {
        return Err(loaded.error.unwrap_or_else(|| "加载失败".to_string()));
    }
    if loaded.position < 0.4 {
        return Err(format!(
            "播放位置异常: {:.3}s（独占回退后应已推进）",
            loaded.position
        ));
    }

    engine.pause();
    std::thread::sleep(Duration::from_millis(350));
    let paused = engine.snapshot();
    println!("paused={} pos={:.3}", !paused.playing, paused.position);
    if paused.playing {
        return Err("暂停未生效".to_string());
    }
    if (paused.position - loaded.position).abs() > 0.15 {
        return Err(format!(
            "暂停后位置仍在前进: {:.3} -> {:.3}",
            loaded.position, paused.position
        ));
    }

    engine.seek(1.0);
    std::thread::sleep(Duration::from_millis(300));
    let sought = engine.snapshot();
    println!("seek pos={:.3} playing={}", sought.position, sought.playing);
    if (sought.position - 1.0).abs() > 0.15 {
        return Err(format!("seek 位置异常: {:.3}s（期望约 1.0s）", sought.position));
    }

    engine.play();
    std::thread::sleep(Duration::from_millis(350));
    let resumed = engine.snapshot();
    println!("resumed pos={:.3} playing={}", resumed.position, resumed.playing);
    if !resumed.playing {
        return Err("恢复播放失败".to_string());
    }
    if resumed.position <= sought.position + 0.1 {
        return Err(format!(
            "恢复播放后位置未推进: {:.3} -> {:.3}",
            sought.position, resumed.position
        ));
    }

    engine.set_output_mode(OutputMode::Shared);
    std::thread::sleep(Duration::from_millis(500));
    let shared = engine.snapshot();
    println!(
        "switch shared: mode={} out={}Hz/{}ch/{} playing={} pos={:.3}",
        shared.output_mode,
        shared.output_rate,
        shared.output_channels,
        shared.output_format,
        shared.playing,
        shared.position
    );
    if !shared.output_mode.contains("共享") {
        return Err(format!("切换到共享模式失败: {}", shared.output_mode));
    }
    if !shared.playing || shared.position <= resumed.position {
        return Err("切换输出模式后播放未继续".to_string());
    }

    engine.set_output_mode(OutputMode::Exclusive);
    std::thread::sleep(Duration::from_millis(1200));
    let exclusive_again = engine.snapshot();
    println!(
        "switch exclusive: mode={} out={}Hz/{}ch/{} playing={} pos={:.3} note={:?}",
        exclusive_again.output_mode,
        exclusive_again.output_rate,
        exclusive_again.output_channels,
        exclusive_again.output_format,
        exclusive_again.playing,
        exclusive_again.position,
        exclusive_again.note
    );

    println!("engine check OK");
    Ok(())
}

fn wasapi_check() -> Result<()> {
    for line in matemusic_lib::audio::diagnose_wasapi() {
        println!("{line}");
    }
    Ok(())
}

fn recovery_check(path: &Path) -> Result<()> {
    let engine = AudioEngine::spawn(|snapshot| {
        if let Some(err) = snapshot.error {
            eprintln!("engine state error: {err}");
        }
    });
    engine.set_output_mode(OutputMode::Shared);
    engine.set_volume(0.25);
    engine.load(path.to_path_buf());
    std::thread::sleep(Duration::from_millis(1200));

    let before = engine.snapshot();
    println!(
        "before failure: loaded={} playing={} pos={:.3} mode={}",
        before.loaded, before.playing, before.position, before.output_mode
    );
    if !before.loaded || !before.playing {
        return Err(before.error.unwrap_or_else(|| "加载失败".to_string()));
    }

    engine.simulate_output_failure();
    std::thread::sleep(Duration::from_millis(2600));
    let after = engine.snapshot();
    println!(
        "after recovery: loaded={} playing={} pos={:.3} mode={} note={:?}",
        after.loaded, after.playing, after.position, after.output_mode, after.note
    );

    if !after.loaded || !after.playing {
        return Err("输出设备恢复后未继续播放".to_string());
    }
    if after.position < before.position + 0.3 {
        return Err(format!(
            "恢复后位置未推进: {:.3} -> {:.3}",
            before.position, after.position
        ));
    }
    if !after.output_mode.contains("共享") {
        return Err(format!("恢复后输出模式异常: {}", after.output_mode));
    }

    println!("recovery check OK");
    Ok(())
}

fn matrix_check(dir: &Path) -> Result<()> {
    let engine = AudioEngine::spawn(|snapshot| {
        if let Some(err) = snapshot.error {
            eprintln!("engine state error: {err}");
        }
    });
    engine.set_output_mode(OutputMode::Shared);

    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("读取目录失败: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();

    let supported = ["flac", "mp3", "m4a", "ogg", "wav", "aiff", "aif", "alac"];
    let unsupported = ["ape", "wma", "opus", "dsf", "dff"];
    let mut failures = 0;

    for path in files {
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if !supported.contains(&ext.as_str()) && !unsupported.contains(&ext.as_str()) {
            continue;
        }

        engine.load(path.clone());
        std::thread::sleep(Duration::from_millis(700));
        let snapshot = engine.snapshot();
        let ok = if unsupported.contains(&ext.as_str()) {
            !snapshot.loaded
                && snapshot
                    .error
                    .as_deref()
                    .map(|error| error.contains("缺少"))
                    .unwrap_or(false)
        } else {            snapshot.loaded && snapshot.playing && snapshot.position > 0.05
        };

        println!(
            "{:<18} {:<5} codec={:<10} {} Hz/{:?} bit loaded={} playing={} pos={:.2} error={:?} => {}",
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("?"),
            ext,
            snapshot.codec,
            snapshot.sample_rate,
            snapshot.bits,
            snapshot.loaded,
            snapshot.playing,
            snapshot.position,
            snapshot.error,
            if ok { "OK" } else { "FAIL" }
        );

        if !ok {
            failures += 1;
        }
        engine.pause();
        std::thread::sleep(Duration::from_millis(150));
    }

    if failures > 0 {
        Err(format!("{failures} format(s) failed"))
    } else {
        println!("format matrix OK");
        Ok(())
    }
}

fn usage() -> ! {
    eprintln!(
        "MateMusic audio probe (M1 spike)\n\
         \n\
         USAGE:\n\
         \x20 audio_probe probe  <file>\n\
         \x20 audio_probe play   <file>\n\
         \x20 audio_probe engine <file>   # 流式引擎：加载/暂停/seek/恢复自检\n\
         \x20 audio_probe recovery <file> # 输出设备异常：暂停/重开/续播自检\n\
         \x20 audio_probe matrix <dir>    # 格式矩阵：解码与共享输出自检\n\
         \x20 audio_probe wasapi          # WASAPI 共享/独占格式能力诊断\n"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "wasapi" {
        if let Err(err) = wasapi_check() {
            eprintln!("错误: {err}");
            std::process::exit(1);
        }
        return;
    }
    if args.len() < 3 {
        usage();
    }

    let path = PathBuf::from(&args[2]);
    let result = match args[1].as_str() {
        "probe" => probe(&path),
        "play" => play(&path),
        "engine" => engine_check(&path),
        "recovery" => recovery_check(&path),
        "matrix" => matrix_check(&path),
        _ => usage(),
    };

    if let Err(err) = result {
        eprintln!("错误: {err}");
        std::process::exit(1);
    }
}
