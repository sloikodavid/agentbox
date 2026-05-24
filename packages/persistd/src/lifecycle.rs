#![cfg(unix)]

use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Initializing,
    Running,
    Degraded,
    Stopped,
}

impl LifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::Running => "running",
            Self::Degraded => "degraded",
            Self::Stopped => "stopped",
        }
    }

    fn code(self) -> u8 {
        match self {
            Self::Initializing => 0,
            Self::Running => 1,
            Self::Degraded => 2,
            Self::Stopped => 3,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Running,
            2 => Self::Degraded,
            3 => Self::Stopped,
            _ => Self::Initializing,
        }
    }
}

#[derive(Clone)]
pub struct LifecycleStatus {
    state: Arc<AtomicU8>,
}

impl LifecycleStatus {
    pub fn new(initial: LifecycleState) -> Self {
        Self {
            state: Arc::new(AtomicU8::new(initial.code())),
        }
    }

    pub fn set(&self, state: LifecycleState) {
        self.state.store(state.code(), Ordering::SeqCst);
    }

    pub fn get(&self) -> LifecycleState {
        LifecycleState::from_code(self.state.load(Ordering::SeqCst))
    }

    pub fn text(&self) -> String {
        self.get().as_str().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{LifecycleState, LifecycleStatus};

    #[test]
    fn lifecycle_status_is_shared() {
        let status = LifecycleStatus::new(LifecycleState::Initializing);
        let clone = status.clone();

        clone.set(LifecycleState::Degraded);

        assert_eq!(status.get(), LifecycleState::Degraded);
        assert_eq!(status.text(), "degraded");
    }
}
