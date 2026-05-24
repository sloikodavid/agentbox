#![cfg(unix)]

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc,
};

use crate::public::PublicPath;

#[derive(Clone)]
pub struct DirtySender {
    tx: mpsc::Sender<PublicPath>,
    pending: Arc<AtomicU64>,
}

impl DirtySender {
    pub fn new(tx: mpsc::Sender<PublicPath>, pending: Arc<AtomicU64>) -> Self {
        Self { tx, pending }
    }

    pub fn send(&self, public_path: PublicPath) -> Result<(), mpsc::SendError<PublicPath>> {
        self.pending.fetch_add(1, Ordering::SeqCst);
        match self.tx.send(public_path) {
            Ok(()) => Ok(()),
            Err(error) => {
                mark_processed(&self.pending);
                Err(error)
            }
        }
    }

    pub fn mark_processed(&self) {
        mark_processed(&self.pending);
    }
}

pub fn pending_count(pending: &AtomicU64) -> u64 {
    pending.load(Ordering::SeqCst)
}

pub fn mark_processed(pending: &AtomicU64) {
    let _ = pending.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        Some(value.saturating_sub(1))
    });
}

#[cfg(test)]
mod tests {
    use super::{DirtySender, pending_count};
    use std::sync::{Arc, atomic::AtomicU64, mpsc};

    #[test]
    fn sender_tracks_pending_depth() {
        let (tx, rx) = mpsc::channel();
        let pending = Arc::new(AtomicU64::new(0));
        let sender = DirtySender::new(tx, Arc::clone(&pending));

        sender
            .send(crate::public::PublicPath::parse("/etc/hosts").unwrap())
            .unwrap();

        assert_eq!(pending_count(&pending), 1);
        assert_eq!(rx.recv().unwrap().as_bytes(), b"/etc/hosts");
        sender.mark_processed();
        assert_eq!(pending_count(&pending), 0);
    }
}
