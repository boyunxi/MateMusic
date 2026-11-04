pub mod audio;

use std::path::PathBuf;
use std::sync::Mutex;

use audio::{AudioEngine, PlayerSnapshot};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    stage: &'static str,
}

struct EngineState(Mutex<AudioEngine>);

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "MateMusic",
        version: env!("CARGO_PKG_VERSION"),
        stage: "M1-audio",
    }
}

#[tauri::command]
fn player_load(state: State<'_, EngineState>, path: String) {
    if let Ok(engine) = state.0.lock() {
        engine.load(PathBuf::from(path));
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
fn player_state(state: State<'_, EngineState>) -> PlayerSnapshot {
    state
        .0
        .lock()
        .map(|engine| engine.snapshot())
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let engine = AudioEngine::spawn(move |snapshot| {
                let _ = handle.emit("playback://state", snapshot);
            });
            app.manage(EngineState(Mutex::new(engine)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            player_load,
            player_play,
            player_pause,
            player_seek,
            player_set_volume,
            player_state
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MateMusic");
}
