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
            if let Err(e) = store.trim(settings.history.effective_retention_days(), queue::now_ms())
            {
                eprintln!("warn: startup history trim failed: {e}");
            }
            app.manage(store);
        }
        Err(e) => {
            eprintln!("warn: history store unavailable, history disabled: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(FileListState(Mutex::new(Vec::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(QueueState::new(handle));
            temp::cleanup_stale_temp_files(app.handle());
            setup_history(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("fatal: failed to start application: {e:#}");
            std::process::exit(1);
        });
}
