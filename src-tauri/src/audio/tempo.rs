use std::f64::consts::TAU;

pub(crate) const MIN_SPEED: f32 = 0.5;
pub(crate) const MAX_SPEED: f32 = 2.0;

fn clamp_speed(speed: f32) -> f32 {
    if speed.is_finite() {
        speed.clamp(MIN_SPEED, MAX_SPEED)
    } else {
        1.0
    }
}

/// WSOLA 时间伸缩：改变播放速度但保留音高。
/// 输出帧数约为输入帧数 / speed，供引擎把源时间轴映射到输出时间轴。
pub(crate) struct TimeStretcher {
    channels: usize,
    window: usize,
    overlap: usize,
    speed: f32,
    analysis_hop: usize,
    search: usize,
    window_fn: Vec<f32>,
    input: Vec<f32>,
    input_start: u64,
    analysis_pos: u64,
    tail: Vec<f32>,
    started: bool,
}

impl TimeStretcher {
    pub(crate) fn new(channels: usize, sample_rate: u32, speed: f32) -> Self {
        let channels = channels.max(1);
        let rate = sample_rate.max(8_000) as f64;
        let window = ((rate * 0.04) as usize)
            .next_power_of_two()
            .clamp(1024, 8192);
        let overlap = window / 2;
        let search = ((rate * 0.006) as usize)
            .clamp(32, overlap / 3)
            .max(1);
        let window_fn = (0..window)
            .map(|index| {
                let phase = TAU * index as f64 / window as f64;
                (0.5 - 0.5 * phase.cos()) as f32
            })
            .collect();

        let mut stretcher = Self {
            channels,
            window,
            overlap,
            speed: 1.0,
            analysis_hop: overlap,
            search,
            window_fn,
            input: Vec::new(),
            input_start: 0,
            analysis_pos: 0,
            tail: Vec::new(),
            started: false,
        };
        stretcher.reset(speed);
        stretcher
    }

    pub(crate) fn reset(&mut self, speed: f32) {
        self.speed = clamp_speed(speed);
        self.analysis_hop = ((self.overlap as f64) * self.speed as f64)
            .round()
            .max(1.0) as usize;
        self.input.clear();
        self.input_start = 0;
        self.analysis_pos = 0;
        self.tail.clear();
        self.started = false;
    }

    fn input_frames(&self) -> usize {
        self.input.len() / self.channels
    }

    fn segment(&self, start_frame: u64, frames: usize) -> &[f32] {
        let offset = (start_frame - self.input_start) as usize * self.channels;
        &self.input[offset..offset + frames * self.channels]
    }

    fn best_start(&self, low: u64, high: u64, expected: u64) -> u64 {
        if low >= high {
            return expected.clamp(low, high);
        }
        let tail_energy: f64 = self
            .tail
            .iter()
            .map(|sample| (*sample as f64) * (*sample as f64))
            .sum();
        if tail_energy <= 1e-12 {
            return expected.clamp(low, high);
        }
        let tail_energy = tail_energy.sqrt();

        let mut best = expected.clamp(low, high);
        let mut best_score = f64::NEG_INFINITY;
        let mut start = low;
        let step = if high - low > 256 { 2 } else { 1 };
        while start <= high {
            let segment = self.segment(start, self.overlap);
            let mut dot = 0.0f64;
            let mut energy = 0.0f64;
            for (sample, tail) in segment.iter().zip(self.tail.iter()) {
                let sample = *sample as f64;
                dot += sample * (*tail as f64);
                energy += sample * sample;
            }
            if energy > 1e-12 {
                let score = dot / (energy.sqrt() * tail_energy);
                if score > best_score {
                    best_score = score;
                    best = start;
                }
            }
            start += step;
        }

        if best_score.is_finite() {
            best
        } else {
            expected.clamp(low, high)
        }
    }

    fn step(&mut self, output: &mut Vec<f32>) -> bool {
        let channels = self.channels;
        let window = self.window;
        let overlap = self.overlap;
        let available_end = self.input_start + self.input_frames() as u64;

        if !self.started {
            if self.analysis_pos + window as u64 > available_end {
                return false;
            }
            let offset = (self.analysis_pos - self.input_start) as usize * channels;
            let segment = &self.input[offset..offset + window * channels];
            output.extend_from_slice(&segment[..overlap * channels]);
            self.tail.clear();
            for index in overlap..window {
                let weight = self.window_fn[index];
                for channel in 0..channels {
                    self.tail.push(segment[index * channels + channel] * weight);
                }
            }
            self.started = true;
            self.analysis_pos += self.analysis_hop as u64;
            return true;
        }

        let expected = self.analysis_pos;
        let low = expected
            .saturating_sub(self.search as u64)
            .max(self.input_start);
        let high = (expected + self.search as u64).min(available_end.saturating_sub(window as u64));
        if low > high {
            return false;
        }

        let start = self.best_start(low, high, expected);
        let offset = (start - self.input_start) as usize * channels;
        let segment = &self.input[offset..offset + window * channels];

        for index in 0..overlap {
            let weight = self.window_fn[index];
            for channel in 0..channels {
                let sample = segment[index * channels + channel] * weight;
                output.push(self.tail[index * channels + channel] + sample);
            }
        }

        self.tail.clear();
        for index in overlap..window {
            let weight = self.window_fn[index];
            for channel in 0..channels {
                self.tail.push(segment[index * channels + channel] * weight);
            }
        }

        self.analysis_pos = expected + self.analysis_hop as u64;
        true
    }

    fn prune(&mut self) {
        let keep_from = self.analysis_pos.saturating_sub(self.search as u64);
        if keep_from <= self.input_start {
            return;
        }
        let drop_frames = (keep_from - self.input_start) as usize;
        let drop_samples = drop_frames.saturating_mul(self.channels);
        if drop_samples > self.input.len() {
            return;
        }
        self.input.drain(..drop_samples);
        self.input_start += drop_frames as u64;
    }

    pub(crate) fn process(&mut self, interleaved: &[f32], output: &mut Vec<f32>) {
        let usable = interleaved.len() - interleaved.len() % self.channels;
        self.input.extend_from_slice(&interleaved[..usable]);

        loop {
            let available_end = self.input_start + self.input_frames() as u64;
            let needed = if self.started {
                self.analysis_pos + self.search as u64 + self.window as u64
            } else {
                self.window as u64
            };
            if available_end < needed || !self.step(output) {
                break;
            }
        }

        self.prune();
    }

    pub(crate) fn flush(&mut self, output: &mut Vec<f32>) {
        if self.started && !self.tail.is_empty() {
            output.extend_from_slice(&self.tail);
        }
        let frames = self.input_frames() as u64;
        self.input.clear();
        self.input_start += frames;
        self.tail.clear();
        self.started = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, seconds: f64, frequency: f64) -> Vec<f32> {
        let frames = (rate as f64 * seconds) as usize;
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let value = (TAU * frequency * frame as f64 / rate as f64).sin() as f32 * 0.5;
            samples.push(value);
            samples.push(value);
        }
        samples
    }

    fn estimated_frequency(samples: &[f32], channels: usize, rate: f64) -> f64 {
        let frames = samples.len() / channels;
        let skip = (rate * 0.2) as usize;
        if frames <= skip * 2 {
            return 0.0;
        }
        let mut crossings = 0usize;
        let mut previous = samples[skip * channels];
        for frame in skip + 1..frames - skip {
            let current = samples[frame * channels];
            if (previous < 0.0 && current >= 0.0) || (previous >= 0.0 && current < 0.0) {
                crossings += 1;
            }
            previous = current;
        }
        let duration = (frames - skip * 2) as f64 / rate;
        crossings as f64 / 2.0 / duration
    }

    fn run(speed: f32) -> f64 {
        let rate = 44_100u32;
        let input = sine(rate, 3.0, 440.0);
        let mut stretcher = TimeStretcher::new(2, rate, speed);
        let mut output = Vec::new();
        for chunk in input.chunks(2048 * 2) {
            stretcher.process(chunk, &mut output);
        }
        stretcher.flush(&mut output);
        estimated_frequency(&output, 2, rate as f64)
    }

    #[test]
    fn preserves_pitch_at_faster_speed() {
        let frequency = run(1.5);
        assert!((frequency - 440.0).abs() < 18.0, "frequency {frequency}");
    }

    #[test]
    fn preserves_pitch_at_slower_speed() {
        let frequency = run(0.75);
        assert!((frequency - 440.0).abs() < 18.0, "frequency {frequency}");
    }

    #[test]
    fn stretch_ratio_is_close() {
        let rate = 44_100u32;
        let input = sine(rate, 3.0, 440.0);
        let input_frames = input.len() / 2;
        for speed in [0.75f32, 1.25, 1.5] {
            let mut stretcher = TimeStretcher::new(2, rate, speed);
            let mut output = Vec::new();
            for chunk in input.chunks(2048 * 2) {
                stretcher.process(chunk, &mut output);
            }
            stretcher.flush(&mut output);
            let ratio = output.len() as f64 / 2.0 / input_frames as f64;
            let expected = 1.0 / speed as f64;
            assert!(
                (ratio - expected).abs() < 0.08,
                "speed {speed}: ratio {ratio} expected {expected}"
            );
        }
    }
}
