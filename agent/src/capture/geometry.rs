//! Process-local capture/input authority. JPEG APP15 exposes the exact frame geometry.
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopRect {
    pub x: i32,
    pub y: i32,
    pub physical_width: u32,
    pub physical_height: u32,
}
impl DesktopRect {
    pub fn valid(self) -> bool {
        self.physical_width > 0
            && self.physical_height > 0
            && i64::from(self.x) + i64::from(self.physical_width) - 1 <= i64::from(i32::MAX)
            && i64::from(self.y) + i64::from(self.physical_height) - 1 <= i64::from(i32::MAX)
    }
    pub fn map(self, frame_width: u32, frame_height: u32, x: i32, y: i32) -> Option<(i32, i32)> {
        if !self.valid() || frame_width == 0 || frame_height == 0 {
            return None;
        }
        fn axis(origin: i32, size: u32, frame: u32, p: i32) -> i32 {
            let p = i64::from(p).clamp(0, i64::from(frame) - 1);
            let offset = if frame == 1 {
                0
            } else {
                (p * (i64::from(size) - 1) + (i64::from(frame) - 1) / 2) / (i64::from(frame) - 1)
            };
            (i64::from(origin) + offset) as i32
        }
        Some((
            axis(self.x, self.physical_width, frame_width, x),
            axis(self.y, self.physical_height, frame_height, y),
        ))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrameGeometry {
    pub capture_id: String,
    pub geometry_revision: u64,
    pub monitor_index: Option<usize>,
    pub desktop: Option<DesktopRect>,
    pub frame_width: u32,
    pub frame_height: u32,
}
#[derive(Default)]
pub struct Selection {
    id: Option<String>,
    revision: u64,
    frame: Option<FrameGeometry>,
    legacy_primary: bool,
}
impl Selection {
    fn begin(&mut self, id: String, legacy_primary: bool) {
        self.id = Some(id);
        self.revision = 0;
        self.frame = None;
        self.legacy_primary = legacy_primary;
    }
    fn publish(
        &mut self,
        id: &str,
        monitor_index: Option<usize>,
        desktop: Option<DesktopRect>,
        w: u32,
        h: u32,
    ) -> Option<FrameGeometry> {
        if self.id.as_deref() != Some(id) || w == 0 || h == 0 {
            return None;
        }
        let desktop = desktop.filter(|d| d.valid());
        let changed = self.frame.as_ref().is_none_or(|f| {
            f.monitor_index != monitor_index
                || f.desktop != desktop
                || f.frame_width != w
                || f.frame_height != h
        });
        if changed {
            self.revision = self.revision.checked_add(1)?;
        }
        let f = FrameGeometry {
            capture_id: id.into(),
            geometry_revision: self.revision,
            monitor_index,
            desktop,
            frame_width: w,
            frame_height: h,
        };
        self.frame = Some(f.clone());
        Some(f)
    }
    pub fn map_command(&self, v: &mut serde_json::Value) -> anyhow::Result<()> {
        let id = v.get("capture_id");
        let revision = v.get("geometry_revision");
        let stamped = id.is_some() || revision.is_some();
        if stamped {
            anyhow::ensure!(
                self.frame
                    .as_ref()
                    .is_some_and(
                        |f| id.and_then(|v| v.as_str()) == Some(f.capture_id.as_str())
                            && revision.and_then(|v| v.as_u64()) == Some(f.geometry_revision)
                    ),
                "stale capture geometry"
            );
        }
        if !matches!(
            v["type"].as_str(),
            Some("MouseMove" | "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp")
        ) {
            return Ok(());
        }
        let x = v["x"]
            .as_i64()
            .and_then(|x| i32::try_from(x).ok())
            .ok_or_else(|| anyhow::anyhow!("invalid x"))?;
        let y = v["y"]
            .as_i64()
            .and_then(|y| i32::try_from(y).ok())
            .ok_or_else(|| anyhow::anyhow!("invalid y"))?;
        let point = self
            .frame
            .as_ref()
            .and_then(|f| f.desktop?.map(f.frame_width, f.frame_height, x, y));
        if let Some((x, y)) = point {
            v["x"] = x.into();
            v["y"] = y.into();
        } else {
            anyhow::ensure!(
                !stamped && (self.id.is_none() || (self.legacy_primary && self.frame.is_some())),
                "capture geometry unavailable"
            );
        }
        Ok(())
    }
}
static SELECTION: Mutex<Selection> = Mutex::new(Selection {
    id: None,
    revision: 0,
    frame: None,
    legacy_primary: false,
});
pub fn selection() -> MutexGuard<'static, Selection> {
    SELECTION.lock().unwrap_or_else(|e| e.into_inner())
}
pub struct CaptureSession {
    id: String,
}
impl CaptureSession {
    pub fn begin(legacy_primary: bool) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        selection().begin(id.clone(), legacy_primary);
        Self { id }
    }
    pub fn invalidate(&self) {
        let mut s = selection();
        if s.id.as_deref() == Some(&self.id) {
            s.frame = None;
        }
    }
    pub fn current(&self) -> bool {
        selection().id.as_deref() == Some(&self.id)
    }
    pub fn frame(
        &self,
        monitor: Option<usize>,
        rect: Option<DesktopRect>,
        w: u32,
        h: u32,
        mut jpeg: Vec<u8>,
    ) -> Option<Vec<u8>> {
        let mut state = selection();
        let f = state.publish(&self.id, monitor, rect, w, h)?;
        let mut data = b"VantyrGeometry\0".to_vec();
        data.extend(
            serde_json::to_vec(
                &serde_json::json!({"type":"capture_geometry", "schema_version":1, "geometry":f}),
            )
            .ok()?,
        );
        let len = u16::try_from(data.len() + 2).ok()?;
        if !jpeg.starts_with(&[0xff, 0xd8]) {
            return None;
        }
        let mut marker = vec![0xff, 0xef];
        marker.extend(len.to_be_bytes());
        marker.extend(data);
        jpeg.splice(2..2, marker);
        Some(jpeg)
    }
}
impl Drop for CaptureSession {
    fn drop(&mut self) {
        let mut s = selection();
        if s.id.as_deref() == Some(&self.id) {
            *s = Selection::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scale_clamp_negative_and_portrait() {
        let r = DesktopRect {
            x: -1080,
            y: -200,
            physical_width: 1080,
            physical_height: 1920,
        };
        assert_eq!(r.map(540, 960, 0, 0), Some((-1080, -200)));
        assert_eq!(r.map(540, 960, 539, 959), Some((-1, 1719)));
        assert_eq!(r.map(540, 960, -9, 9999), Some((-1080, 1719)));
        assert_eq!(r.map(1080, 1920, 300, 400), Some((-780, 200)));
        assert_eq!(r.map(1, 1, 5, 5), Some((-1080, -200)));
        assert_eq!(r.map(0, 960, 0, 0), None);
    }
    #[test]
    fn invalid_geometry_and_overflow() {
        assert!(!DesktopRect {
            x: i32::MAX,
            y: 0,
            physical_width: 2,
            physical_height: 1
        }
        .valid());
        assert!(!DesktopRect {
            x: 0,
            y: 0,
            physical_width: 0,
            physical_height: 1
        }
        .valid());
    }
    #[test]
    fn switch_fences_old_frames_and_commands() {
        let mut s = Selection::default();
        let r = DesktopRect {
            x: -100,
            y: 0,
            physical_width: 100,
            physical_height: 100,
        };
        s.begin("first".into(), false);
        let f = s.publish("first", Some(1), Some(r), 50, 50).unwrap();
        let mut cmd = serde_json::json!({"type":"MouseMove","x":49,"y":49,"capture_id":f.capture_id,"geometry_revision":f.geometry_revision});
        assert!(s.map_command(&mut cmd).is_ok());
        assert_eq!(cmd["x"], -1);
        s.begin("second".into(), false);
        assert!(s.publish("first", Some(1), Some(r), 50, 50).is_none());
        s.publish("second", Some(1), Some(r), 50, 50).unwrap();
        assert!(s.map_command(&mut cmd).is_err());
        let current = s.frame.clone().unwrap();
        s.publish("second", Some(1), Some(r), 100, 100).unwrap();
        assert!(s.map_command(&mut serde_json::json!({"type":"KeyDown","capture_id":current.capture_id,"geometry_revision":current.geometry_revision})).is_err());
    }
    #[test]
    fn jpeg_marker_and_old_worker_drop() {
        let first = CaptureSession::begin(true);
        let second = CaptureSession::begin(false);
        drop(first);
        assert!(second.current());
        let r = DesktopRect {
            x: 1920,
            y: -400,
            physical_width: 1080,
            physical_height: 1920,
        };
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        let marked = second.frame(Some(1), Some(r), 540, 960, jpeg).unwrap();
        assert_eq!(&marked[..4], &[0xff, 0xd8, 0xff, 0xef]);
        let n = u16::from_be_bytes(marked[4..6].try_into().unwrap()) as usize;
        assert_eq!(&marked[6..21], b"VantyrGeometry\0");
        let data: serde_json::Value = serde_json::from_slice(&marked[21..4 + n]).unwrap();
        assert_eq!(data["geometry"]["desktop"]["x"], 1920);
        assert_eq!(data["geometry"]["frame_width"], 540);
        assert_eq!(&marked[4 + n..], &[0xff, 0xd9]);
        let before = data["geometry"]["geometry_revision"].as_u64().unwrap();
        second.invalidate();
        assert!(selection()
            .map_command(&mut serde_json::json!({"type":"MouseMove","x":0,"y":0}))
            .is_err());
        second
            .frame(Some(1), Some(r), 540, 960, vec![0xff, 0xd8, 0xff, 0xd9])
            .unwrap();
        assert!(selection().frame.as_ref().unwrap().geometry_revision > before);
    }
    #[test]
    fn legacy_and_unavailable_metadata() {
        let mut s = Selection::default();
        let mut c = serde_json::json!({"type":"MouseMove","x":12,"y":13});
        assert!(s.map_command(&mut c).is_ok());
        s.begin("a".into(), true);
        assert!(s.map_command(&mut c).is_err());
        s.publish("a", None, None, 100, 100);
        assert!(s.map_command(&mut c).is_ok());
        assert!(s.map_command(&mut serde_json::json!({"type":"MouseMove","x":12,"y":13,"capture_id":"a","geometry_revision":1})).is_err());
        s.begin("b".into(), false);
        s.publish("b", None, None, 100, 100);
        assert!(s.map_command(&mut c).is_err());
    }
}
