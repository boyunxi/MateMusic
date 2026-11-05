use tauri::{AppHandle, Emitter};
use windows::core::{factory, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
    SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{
    ISystemMediaTransportControlsInterop, RoInitialize, RO_INIT_MULTITHREADED,
};

use crate::audio::PlayerSnapshot;

const TICKS_PER_SECOND: f64 = 10_000_000.0;

pub struct SmtcController {
    controls: SystemMediaTransportControls,
    title: String,
    artist: String,
    album: String,
    last_status: MediaPlaybackStatus,
    last_position_secs: i64,
    last_duration: f64,
    last_speed: f64,
}

impl SmtcController {
    pub fn create(app: AppHandle, hwnd: HWND) -> Result<Self, String> {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }

        let interop: ISystemMediaTransportControlsInterop =
            factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()
                .map_err(|error| format!("SMTC 工厂创建失败: {error}"))?;
        let controls: SystemMediaTransportControls = unsafe { interop.GetForWindow(hwnd) }
            .map_err(|error| format!("SMTC 绑定窗口失败: {error}"))?;

        let _ = controls.SetIsEnabled(true);
        let _ = controls.SetIsPlayEnabled(true);
        let _ = controls.SetIsPauseEnabled(true);
        let _ = controls.SetIsNextEnabled(true);
        let _ = controls.SetIsPreviousEnabled(true);
        let _ = controls.SetIsStopEnabled(false);

        let handler = TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_sender, args| {
            if let Some(args) = args.as_ref() {
                if let Ok(button) = args.Button() {
                    let action = if button == SystemMediaTransportControlsButton::Play
                        || button == SystemMediaTransportControlsButton::Pause
                    {
                        "toggle"
                    } else if button == SystemMediaTransportControlsButton::Next {
                        "next"
                    } else if button == SystemMediaTransportControlsButton::Previous {
                        "previous"
                    } else {
                        ""
                    };
                    if !action.is_empty() {
                        let _ = app.emit("shortcut://action", action.to_string());
                    }
                }
            }
            Ok(())
        });
        let _ = controls.ButtonPressed(&handler);

        Ok(Self {
            controls,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            last_status: MediaPlaybackStatus::Closed,
            last_position_secs: -1,
            last_duration: -1.0,
            last_speed: -1.0,
        })
    }

    pub fn set_metadata(&mut self, title: &str, artist: &str, album: &str) {
        if self.title == title && self.artist == artist && self.album == album {
            return;
        }
        self.title = title.to_string();
        self.artist = artist.to_string();
        self.album = album.to_string();

        let Ok(updater) = self.controls.DisplayUpdater() else {
            return;
        };
        let _ = updater.SetType(MediaPlaybackType::Music);
        if let Ok(properties) = updater.MusicProperties() {
            let _ = properties.SetTitle(&HSTRING::from(title));
            let _ = properties.SetArtist(&HSTRING::from(artist));
            let _ = properties.SetAlbumTitle(&HSTRING::from(album));
        }
        let _ = updater.Update();
    }

    pub fn update_snapshot(&mut self, snapshot: &PlayerSnapshot) {
        let status = if !snapshot.loaded {
            MediaPlaybackStatus::Stopped
        } else if snapshot.playing {
            MediaPlaybackStatus::Playing
        } else {
            MediaPlaybackStatus::Paused
        };
        if status != self.last_status {
            if self.controls.SetPlaybackStatus(status).is_ok() {
                self.last_status = status;
            }
        }

        let speed = snapshot.speed.max(0.1) as f64;
        if (speed - self.last_speed).abs() > 0.001 {
            if self.controls.SetPlaybackRate(speed).is_ok() {
                self.last_speed = speed;
            }
        }

        let position = snapshot.position.clamp(0.0, snapshot.duration.max(0.0));
        let position_secs = position.floor() as i64;
        if position_secs == self.last_position_secs
            && (snapshot.duration - self.last_duration).abs() <= 0.05
        {
            return;
        }

        let Ok(timeline) = SystemMediaTransportControlsTimelineProperties::new() else {
            return;
        };
        let end = (snapshot.duration.max(0.0) * TICKS_PER_SECOND) as i64;
        let ticks = (position * TICKS_PER_SECOND) as i64;
        let _ = timeline.SetStartTime(TimeSpan { Duration: 0 });
        let _ = timeline.SetEndTime(TimeSpan { Duration: end });
        let _ = timeline.SetPosition(TimeSpan { Duration: ticks });
        let _ = timeline.SetMinSeekTime(TimeSpan { Duration: 0 });
        let _ = timeline.SetMaxSeekTime(TimeSpan { Duration: end });
        if self.controls.UpdateTimelineProperties(&timeline).is_ok() {
            self.last_position_secs = position_secs;
            self.last_duration = snapshot.duration;
        }
    }
}
