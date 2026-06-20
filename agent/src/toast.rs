//! Windows toast notifications via `WinRT`. Uses the `PowerShell` **App User Model ID** so
//! toasts appear as from `PowerShell` when Vantyr has no registered AUMID (same as
//! classic `winrt-notification` + `POWERSHELL_APP_ID`).

use std::thread;
use std::time::Duration;

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use xml::escape::escape_str_attribute;

pub struct Toast {
    title: String,
    line1: String,
    app_id: String,
}

impl Toast {
    /// Toast source identity (shows as `PowerShell` in Action Center).
    pub const POWERSHELL_APP_ID: &'static str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\
                                                 \\WindowsPowerShell\\v1.0\\powershell.exe";

    pub fn new(app_id: &str) -> Self {
        Self {
            title: String::new(),
            line1: String::new(),
            app_id: app_id.to_string(),
        }
    }

    pub fn title(mut self, content: &str) -> Self {
        self.title = format!(r#"<text id="1">{}</text>"#, escape_str_attribute(content));
        self
    }

    pub fn text1(mut self, content: &str) -> Self {
        self.line1 = format!(r#"<text id="2">{}</text>"#, escape_str_attribute(content));
        self
    }

    pub fn show(&self) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        let xml = format!(
            "<toast><visual><binding template=\"ToastGeneric\">{}{}</binding></visual></toast>",
            self.title, self.line1
        );
        doc.LoadXml(&HSTRING::from(xml))?;
        let notification = ToastNotification::CreateToastNotification(&doc)?;
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&self.app_id))?;
        let r = notifier.Show(&notification);
        thread::sleep(Duration::from_millis(10));
        r
    }
}
