use std::thread;

use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VIRTUAL_KEY, VK_DOWN,
    VK_I, VK_L, VK_LEFT, VK_Q, VK_RIGHT, VK_SPACE, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

const MODIFIERS: HOT_KEY_MODIFIERS = HOT_KEY_MODIFIERS(MOD_CONTROL.0 | MOD_ALT.0 | MOD_NOREPEAT.0);

const SHORTCUTS: &[(i32, VIRTUAL_KEY, &str)] = &[
    (1, VK_SPACE, "toggle"),
    (2, VK_LEFT, "previous"),
    (3, VK_RIGHT, "next"),
    (4, VK_UP, "volume-up"),
    (5, VK_DOWN, "volume-down"),
    (6, VK_I, "immersive"),
    (7, VK_L, "lyrics"),
    (8, VK_Q, "queue"),
];

pub fn spawn(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("matemusic-shortcuts".to_string())
        .spawn(move || {
            let mut registered = Vec::new();
            for (id, key, action) in SHORTCUTS {
                match unsafe { RegisterHotKey(None, *id, MODIFIERS, key.0 as u32) } {
                    Ok(()) => registered.push(*id),
                    Err(error) => eprintln!("global shortcut {action} unavailable: {error}"),
                }
            }

            if registered.is_empty() {
                return;
            }

            let mut message = MSG::default();
            loop {
                let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                if result.0 == 0 || result.0 == -1 {
                    break;
                }
                if message.message == WM_HOTKEY {
                    let id = message.wParam.0 as i32;
                    if let Some((_, _, action)) = SHORTCUTS.iter().find(|entry| entry.0 == id) {
                        let _ = app.emit("shortcut://action", action.to_string());
                    }
                }
            }
        });
}
