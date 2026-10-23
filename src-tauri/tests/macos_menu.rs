// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
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

#[cfg(target_os = "macos")]
fn main() {
    use tauri::menu::MenuItemKind;

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("the mock app must build");
    let menu = yard_lib::build_macos_menu(&app).expect("the macOS menu must build");

    fn item_text<R: tauri::Runtime>(item: &MenuItemKind<R>) -> String {
        match item {
            MenuItemKind::MenuItem(item) => item.text().expect("menu item text"),
            MenuItemKind::Submenu(item) => item.text().expect("submenu text"),
            MenuItemKind::Predefined(item) => item.text().expect("predefined item text"),
            MenuItemKind::Check(item) => item.text().expect("check item text"),
            MenuItemKind::Icon(item) => item.text().expect("icon item text"),
        }
    }

    let submenus = menu
        .items()
        .expect("the menu items")
        .into_iter()
        .map(|item| match item {
            MenuItemKind::Submenu(submenu) => submenu,
            _ => panic!("the macOS menu must only hold submenus"),
        })
        .collect::<Vec<_>>();
    let titles = submenus
        .iter()
        .map(|submenu| submenu.text().expect("submenu title"))
        .collect::<Vec<_>>();
    let entries = submenus
        .iter()
        .map(|submenu| {
            submenu
                .items()
                .expect("submenu items")
                .iter()
                .map(item_text)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    assert_eq!(titles, ["Yard", "Edit", "Window"]);
    assert_eq!(
        entries,
        [
            vec!["Hide", "Hide Others", "", "Quit"],
            vec!["Undo", "Redo", "", "Cut", "Copy", "Paste", "Select All"],
            vec!["Minimize", "Zoom", "", "Close Window"],
        ]
    );
    assert!(
        entries
            .iter()
            .flatten()
            .all(|text| !text.to_lowercase().contains("about")),
        "the macOS menu must not offer About: the dialog is the only About surface"
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {}
