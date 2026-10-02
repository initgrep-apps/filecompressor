// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

mod commands;
mod detection;
mod engine;
mod history;
mod models;
mod output;
mod processors;
mod queue;
mod scheduler;
mod settings;
mod sidecar;
mod temp;

use commands::FileListState;
use history::HistoryStore;
use queue::QueueState;
use std::sync::Mutex;
use tauri::Manager;

pub(crate) fn setup_history<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    match HistoryStore::new(app) {
        Ok(store) => {
            let settings = commands::load_settings(app);
            let retention = settings.history.effective_retention_days();
            if let Err(e) = store.trim(retention, queue::now_ms()) {
                eprintln!("warn: startup history trim failed (retentionDays={retention}): {e}");
            }
            if !app.manage(store) {
                eprintln!("warn: HistoryStore already managed, new store discarded");
            }
        }
        Err(e) => {
            eprintln!("warn: history store unavailable, history disabled: {e}");
        }
    }
}

pub(crate) fn setup_hook<R: tauri::Runtime>(
    app: &mut tauri::App<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    app.manage(QueueState::new(handle));
    temp::cleanup_stale_temp_files(app.handle());
    setup_history(app.handle());
    Ok(())
}

macro_rules! invoke_handlers {
    () => {
        tauri::generate_handler![
            commands::add_files,
            commands::remove_file,
            commands::clear_list,
            commands::get_settings,
            commands::save_settings,
            commands::reset_settings,
            commands::compress_all,
            commands::cancel_file,
            commands::cancel_all,
            commands::reveal_in_folder,
            commands::get_history,
            commands::clear_history,
            commands::open_folder,
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(FileListState(Mutex::new(Vec::new())))
        .setup(setup_hook)
        .invoke_handler(invoke_handlers!())
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("fatal: failed to start application: {e:#}");
            std::process::exit(1);
        });
}

#[cfg(test)]
mod wiring_tests {
    use super::*;

    fn wiring_app(root: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(root.to_path_buf()),
        );
        ctx.config_mut().identifier = "com.app.test".into();
        tauri::test::mock_builder()
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_store::Builder::default().build())
            .setup(setup_hook)
            .invoke_handler(invoke_handlers!())
            .build(ctx)
            .unwrap()
    }

    #[test]
    fn setup_hook_manages_queue_and_history_states() {
        let root = tempfile::tempdir().unwrap();
        let mut app = wiring_app(root.path());
        app.run_iteration(|_, _| {});
        assert!(
            app.try_state::<HistoryStore>().is_some(),
            "setup_hook must manage HistoryStore; deleting setup_history from the hook fails here"
        );
        assert!(app.try_state::<QueueState<tauri::test::MockRuntime>>().is_some());
    }

    #[test]
    fn registered_commands_answer_ipc_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let mut app = wiring_app(root.path());
        app.run_iteration(|_, _| {});
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "get_history".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "filters": {},
                    "page": 0,
                    "pageSize": 50
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        let payload = response.expect("registered get_history must answer the ipc dispatch");
        let value = payload.deserialize::<serde_json::Value>().unwrap();
        assert_eq!(value["page"], 0);
        assert_eq!(value["pageSize"], 50);
        assert_eq!(value["totalSessions"], 0);
    }

    #[test]
    fn startup_trim_failure_still_manages_history_store() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("history.jsonl")).unwrap();
        std::fs::write(
            root.path().join("settings.json"),
            serde_json::json!({ "settings": { "history": { "retentionDays": 10 } } }).to_string(),
        )
        .unwrap();

        let mut app = wiring_app(root.path());
        app.run_iteration(|_, _| {});

        assert!(
            app.try_state::<HistoryStore>().is_some(),
            "startup trim failure must not disable history for the session"
        );
    }
}
