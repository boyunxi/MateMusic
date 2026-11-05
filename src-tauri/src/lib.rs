pub mod audio;
pub mod library;
pub mod lyrics;
mod shortcuts;
mod smtc;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use audio::{AudioEngine, OutputMode, PlayerSnapshot};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    stage: &'static str,
}

struct EngineState(Mutex<AudioEngine>);

struct SmtcState(Arc<Mutex<Option<smtc::SmtcController>>>);

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "MateMusic",
        version: env!("CARGO_PKG_VERSION"),
        stage: "M1-audio",
    }
}

#[tauri::command]
fn player_load(
    state: State<'_, EngineState>,
    path: String,
    start: Option<f64>,
    end: Option<f64>,
    autoplay: Option<bool>,
) {
    if let Ok(engine) = state.0.lock() {
        engine.load_range_with_autoplay(
            PathBuf::from(path),
            start.unwrap_or(0.0).max(0.0),
            end,
            autoplay.unwrap_or(true),
        );
    }
}

#[tauri::command]
fn player_set_next(
    state: State<'_, EngineState>,
    path: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
) {
    if let Ok(engine) = state.0.lock() {
        let next = path.map(|path| audio::NextRequest {
            path: PathBuf::from(path),
            start: start.unwrap_or(0.0).max(0.0),
            end,
        });
        engine.set_next(next);
    }
}

#[tauri::command]
fn player_play(state: State<'_, EngineState>) {
    if let Ok(engine) = state.0.lock() {
        engine.play();
    }
}

#[tauri::command]
fn player_pause(state: State<'_, EngineState>) {
    if let Ok(engine) = state.0.lock() {
        engine.pause();
    }
}

#[tauri::command]
fn player_seek(state: State<'_, EngineState>, position: f64) {
    if let Ok(engine) = state.0.lock() {
        engine.seek(position);
    }
}

#[tauri::command]
fn player_set_volume(state: State<'_, EngineState>, volume: f32) {
    if let Ok(engine) = state.0.lock() {
        engine.set_volume(volume);
    }
}

#[tauri::command]
fn player_set_speed(state: State<'_, EngineState>, speed: f32) {
    if let Ok(engine) = state.0.lock() {
        engine.set_speed(speed);
    }
}

#[tauri::command]
fn player_set_output_mode(state: State<'_, EngineState>, mode: String) -> Result<(), String> {
    let mode = OutputMode::parse(&mode).ok_or_else(|| format!("未知输出模式: {mode}"))?;
    if let Ok(engine) = state.0.lock() {
        engine.set_output_mode(mode);
    }
    Ok(())
}

#[tauri::command]
fn player_state(state: State<'_, EngineState>) -> PlayerSnapshot {
    state
        .0
        .lock()
        .map(|engine| engine.snapshot())
        .unwrap_or_default()
}

#[tauri::command]
fn smtc_set_metadata(
    state: State<'_, SmtcState>,
    title: String,
    artist: Option<String>,
    album: Option<String>,
) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(controller) = guard.as_mut() {
            controller.set_metadata(
                &title,
                artist.as_deref().unwrap_or(""),
                album.as_deref().unwrap_or(""),
            );
        }
    }
}

#[tauri::command]
fn smtc_available(state: State<'_, SmtcState>) -> bool {
    state
        .0
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

#[tauri::command]
fn audio_asio_status() -> audio::AsioStatus {
    audio::asio_status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let smtc_slot: Arc<Mutex<Option<smtc::SmtcController>>> =
                Arc::new(Mutex::new(None));
            let smtc_for_engine = Arc::clone(&smtc_slot);
            let handle = app.handle().clone();
            let engine = AudioEngine::spawn(move |snapshot| {
                if let Ok(mut guard) = smtc_for_engine.lock() {
                    if let Some(controller) = guard.as_mut() {
                        controller.update_snapshot(&snapshot);
                    }
                }
                let _ = handle.emit("playback://state", snapshot);
            });
            app.manage(EngineState(Mutex::new(engine)));
            app.manage(SmtcState(Arc::clone(&smtc_slot)));

            if let Some(window) = app.get_webview_window("main") {
                match window.hwnd() {
                    Ok(handle_value) => {
                        let hwnd = windows::Win32::Foundation::HWND(
                            handle_value.0 as *mut core::ffi::c_void,
                        );
                        match smtc::SmtcController::create(app.handle().clone(), hwnd) {
                            Ok(controller) => {
                                if let Ok(mut guard) = smtc_slot.lock() {
                                    *guard = Some(controller);
                                }
                            }
                            Err(error) => eprintln!("smtc: {error}"),
                        }
                    }
                    Err(error) => eprintln!("smtc: 无法获取主窗口句柄: {error}"),
                }
            }

            shortcuts::spawn(app.handle().clone());

            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let library = library::LibraryState::new(
                data_dir.join("matemusic.db"),
                data_dir.join("covers"),
            )
            .map_err(std::io::Error::other)?;
            app.manage(library);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            player_load,
            player_set_next,
            player_play,
            player_pause,
            player_seek,
            player_set_volume,
            player_set_speed,
            player_set_output_mode,
            player_state,
            smtc_set_metadata,
            smtc_available,
            audio_asio_status,
            library::library_import_folder,
            library::library_cancel_scan,
            library::library_scan_status,
            library::library_get_tracks,
            library::library_get_albums,
            library::library_get_artists,
            library::library_get_album_tracks,
            library::library_get_artist_tracks,
            library::library_get_folders,
            library::library_stats,
            library::settings_get_all,
            library::settings_set,
            library::playback_get_state,
            library::playback_save_state,
            library::playlist_list,
            library::playlist_create,
            library::playlist_rename,
            library::playlist_delete,
            library::playlist_add_track,
            library::playlist_remove_track,
            library::playlist_get_tracks,
            lyrics::lyrics_get
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MateMusic");
}
