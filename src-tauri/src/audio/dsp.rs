const BAND_FREQS: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

#[derive(Clone, Debug)]
pub struct DspSettings {
    pub enabled: bool,
    pub bands: [f32; 10],
    pub preamp: f32,
    pub normalize: bool,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            bands: [0.0; 10],
            preamp: 0.0,
            normalize: false,
        }
    }
}

impl DspSettings {
    pub fn from_bands(enabled: bool, bands: Vec<f32>, preamp: f32, normalize: bool) -> Self {
        let mut values = [0.0f32; 10];
        for (slot, value) in values.iter_mut().zip(bands.into_iter()) {
            *slot = value.clamp(-24.0, 24.0);
        }
        Self {
            enabled,
            bands: values,
            preamp: preamp.clamp(-24.0, 24.0),
            normalize,
        }
    }

    fn iso_flat(&self) -> bool {
        self.preamp.abs() < 0.01 && self.bands.iter().all(|gain| gain.abs() < 0.01)
    }
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

#[derive(Clone, Copy, Default)]
struct BiquadState {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }

    fn normalized(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        if a0.abs() < 1e-8 {
            return Self::identity();
        }
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    fn peaking(rate: f32, freq: f32, gain_db: f32, q: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / rate;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.01));
        Self::normalized(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }

    fn low_shelf(rate: f32, freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / rate;
        let cos = w0.cos();
        let alpha = w0.sin() / 2.0 * std::f32::consts::SQRT_2;
        let sqrt_a = a.sqrt();
        Self::normalized(
            a * ((a + 1.0) - (a - 1.0) * cos + 2.0 * sqrt_a * alpha),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
            a * ((a + 1.0) - (a - 1.0) * cos - 2.0 * sqrt_a * alpha),
            (a + 1.0) + (a - 1.0) * cos + 2.0 * sqrt_a * alpha,
            -2.0 * ((a - 1.0) + (a + 1.0) * cos),
            (a + 1.0) + (a - 1.0) * cos - 2.0 * sqrt_a * alpha,
        )
    }

    fn high_shelf(rate: f32, freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq.min(rate * 0.45) / rate;
        let cos = w0.cos();
        let alpha = w0.sin() / 2.0 * std::f32::consts::SQRT_2;
        let sqrt_a = a.sqrt();
        Self::normalized(
            a * ((a + 1.0) + (a - 1.0) * cos + 2.0 * sqrt_a * alpha),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
            a * ((a + 1.0) + (a - 1.0) * cos - 2.0 * sqrt_a * alpha),
            (a + 1.0) - (a - 1.0) * cos + 2.0 * sqrt_a * alpha,
            2.0 * ((a - 1.0) - (a + 1.0) * cos),
            (a + 1.0) - (a - 1.0) * cos - 2.0 * sqrt_a * alpha,
        )
    }

    #[inline]
    fn process(&self, input: f32, state: &mut BiquadState) -> f32 {
        let output = self.b0 * input + self.b1 * state.x1 + self.b2 * state.x2
            - self.a1 * state.y1
            - self.a2 * state.y2;
        state.x2 = state.x1;
        state.x1 = input;
        state.y2 = state.y1;
        state.y1 = output;
        output
    }
}

pub struct DspProcessor {
    settings: DspSettings,
    rate: f32,
    channels: usize,
    filters: Vec<Biquad>,
    states: Vec<Vec<BiquadState>>,
    filters_active: bool,
    preamp_gain: f32,
    env: f32,
    agc_gain: f32,
    env_attack: f32,
    env_release: f32,
    gain_smooth: f32,
}

const AGC_TARGET: f32 = 0.125; // roughly -18 dBFS

impl DspProcessor {
    pub fn new(rate: u32, channels: usize, settings: DspSettings) -> Self {
        let rate = rate.max(8000) as f32;
        let channels = channels.max(1);
        let env_attack = 1.0 - (-1.0 / (0.05 * rate)).exp();
        let env_release = 1.0 - (-1.0 / (0.5 * rate)).exp();
        let gain_smooth = 1.0 - (-1.0 / (0.8 * rate)).exp();
        let mut processor = Self {
            settings: DspSettings::default(),
            rate,
            channels,
            filters: vec![Biquad::identity(); 10],
            states: vec![vec![BiquadState::default(); 10]; channels],
            filters_active: false,
            preamp_gain: 1.0,
            env: 0.0,
            agc_gain: 1.0,
            env_attack,
            env_release,
            gain_smooth,
        };
        processor.set_settings(settings);
        processor
    }

    pub fn reset(&mut self) {
        for channel in &mut self.states {
            channel.fill(BiquadState::default());
        }
        self.env = 0.0;
        self.agc_gain = 1.0;
    }

    pub fn set_settings(&mut self, settings: DspSettings) {
        let normalize_changed = settings.normalize != self.settings.normalize;
        self.filters_active = settings.enabled && !settings.iso_flat();
        self.preamp_gain = 10f32.powf(settings.preamp / 20.0);
        if self.filters_active {
            for (index, gain) in settings.bands.iter().enumerate() {
                let freq = BAND_FREQS[index].min(self.rate * 0.45);
                self.filters[index] = if index == 0 {
                    Biquad::low_shelf(self.rate, freq, *gain)
                } else if index == BAND_FREQS.len() - 1 {
                    Biquad::high_shelf(self.rate, freq, *gain)
                } else {
                    Biquad::peaking(self.rate, freq, *gain, 1.1)
                };
            }
        } else {
            self.filters.fill(Biquad::identity());
        }
        if normalize_changed {
            self.env = 0.0;
            self.agc_gain = 1.0;
        }
        self.settings = settings;
    }

    #[inline]
    pub fn process(&mut self, samples: &mut [f32]) {
        if samples.is_empty() || self.channels == 0 {
            return;
        }
        let eq = self.filters_active;
        let preamp = self.preamp_gain;
        if eq {
            for frame in samples.chunks_exact_mut(self.channels) {
                for (channel, sample) in frame.iter_mut().enumerate() {
                    let mut value = *sample * preamp;
                    let states = &mut self.states[channel];
                    for (filter, state) in self.filters.iter().zip(states.iter_mut()) {
                        value = filter.process(value, state);
                    }
                    *sample = value;
                }
            }
        } else if (preamp - 1.0).abs() > 1e-4 {
            for sample in samples.iter_mut() {
                *sample *= preamp;
            }
        }

        if self.settings.normalize {
            for frame in samples.chunks_exact_mut(self.channels) {
                let peak = frame
                    .iter()
                    .fold(0.0f32, |acc, sample| acc.max(sample.abs()));
                let coefficient = if peak > self.env {
                    self.env_attack
                } else {
                    self.env_release
                };
                self.env += (peak - self.env) * coefficient;
                let desired = if self.env > 1e-4 {
                    (AGC_TARGET / self.env).clamp(0.25, 4.0)
                } else {
                    self.agc_gain
                };
                self.agc_gain += (desired - self.agc_gain) * self.gain_smooth;
                for sample in frame.iter_mut() {
                    *sample = (*sample * self.agc_gain).clamp(-0.98, 0.98);
                }
            }
        }
    }
}
