(function () {
	const narrow = window.matchMedia("(max-width: 600px)");
	let previous = null;
	let pending = false;
	let latePasses = [];
	let overlayBackGuardArmed = false;
	let overlayBackGuardDisarming = false;

	const overlaySelectors = [
		".monaco-menu-container",
		".action-list-submenu-panel",
		".quick-input-widget",
		".monaco-hover:not(.hidden)",
		".editor-widget",
		".suggest-details-container",
		".monaco-dialog-modal-block",
		".monaco-modal-editor-block",
		".notifications-center",
		".notification-toast-container",
		".context-view",
		".monaco-dialog-box",
		".suggest-widget",
		".parameter-hints-widget",
		".rename-box",
		".find-widget",
	];

	function visible(selector) {
		const element = document.querySelector(selector);
		if (!element) {
			return false;
		}

		const style = getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return (
			style.display !== "none" &&
			style.visibility !== "hidden" &&
			rect.width > 0 &&
			rect.height > 0
		);
	}

	function clickAction(labelPrefix) {
		const action = Array.from(document.querySelectorAll("[aria-label]")).find(
			(element) => element.getAttribute("aria-label")?.startsWith(labelPrefix),
		);

		if (action instanceof HTMLElement) {
			action.click();
			return true;
		}

		return false;
	}

	function activeOverlay() {
		if (!narrow.matches) {
			return null;
		}

		for (const selector of overlaySelectors) {
			for (const element of document.querySelectorAll(selector)) {
				if (!(element instanceof HTMLElement)) {
					continue;
				}

				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				if (
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					rect.width > 0 &&
					rect.height > 0
				) {
					return element;
				}
			}
		}

		return null;
	}

	function dispatchEscape() {
		const target =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: document.body;
		const eventInit = {
			key: "Escape",
			code: "Escape",
			keyCode: 27,
			which: 27,
			bubbles: true,
			cancelable: true,
		};

		target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
		target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
	}

	function updateOverlayBackGuard() {
		const overlay = activeOverlay();
		if (overlay && !overlayBackGuardArmed) {
			overlayBackGuardArmed = true;
			history.pushState({ agentboxOverlayBackGuard: true }, "", location.href);
			return;
		}

		if (overlay || !overlayBackGuardArmed) {
			return;
		}

		overlayBackGuardArmed = false;
		if (history.state?.agentboxOverlayBackGuard) {
			overlayBackGuardDisarming = true;
			history.back();
		}
	}

	function handleOverlayBack() {
		if (overlayBackGuardDisarming) {
			overlayBackGuardDisarming = false;
			return;
		}

		if (!overlayBackGuardArmed) {
			return;
		}

		overlayBackGuardArmed = false;
		if (activeOverlay()) {
			dispatchEscape();
			window.setTimeout(updateOverlayBackGuard, 100);
		}
	}

	function snapshot() {
		return {
			auxiliaryBar: visible(".part.auxiliarybar"),
			panel: visible(".part.panel"),
			sideBar: visible(".part.sidebar"),
		};
	}

	function clampPart(selector) {
		const part = document.querySelector(selector);
		if (!(part instanceof HTMLElement)) {
			return;
		}

		const splitView = part.closest(".split-view-view");
		if (!(splitView instanceof HTMLElement)) {
			return;
		}

		if (!narrow.matches) {
			part.style.removeProperty("width");
			splitView.style.removeProperty("width");
			return;
		}

		const rect = part.getBoundingClientRect();
		const width = Math.max(
			0,
			Math.floor(visibleRightEdge(selector, rect.left) - rect.left),
		);
		part.style.width = `${width}px`;
		splitView.style.width = `${width}px`;
	}

	function visibleRightEdge(selector, left) {
		if (selector !== ".part.editor") {
			return window.innerWidth;
		}

		const rightEdges = [window.innerWidth];
		for (const sideSelector of [".part.auxiliarybar"]) {
			const side = document.querySelector(sideSelector);
			if (!(side instanceof HTMLElement) || !visible(sideSelector)) {
				continue;
			}

			const sideRect = side.getBoundingClientRect();
			if (sideRect.left > left) {
				rightEdges.push(sideRect.left);
			}
		}

		return Math.min(...rightEdges);
	}

	function clampVisibleParts() {
		clampPart(".part.editor");
		clampPart(".part.panel");
	}

	function enforce() {
		pending = false;
		updateOverlayBackGuard();

		if (!narrow.matches) {
			clampVisibleParts();
			previous = snapshot();
			return;
		}

		const current = snapshot();
		if (current.sideBar && current.auxiliaryBar) {
			const auxiliaryJustOpened = previous?.auxiliaryBar === false;
			if (auxiliaryJustOpened) {
				clickAction("Toggle Primary Side Bar");
			} else {
				clickAction("Hide Secondary Side Bar") ||
					clickAction("Toggle Secondary Side Bar");
			}
		}

		if (current.panel && (current.sideBar || current.auxiliaryBar)) {
			const panelJustOpened = previous?.panel === false;
			if (panelJustOpened) {
				if (current.sideBar) {
					clickAction("Toggle Primary Side Bar");
				}
				if (current.auxiliaryBar) {
					clickAction("Hide Secondary Side Bar") ||
						clickAction("Toggle Secondary Side Bar");
				}
			} else {
				clickAction("Hide Panel") || clickAction("Toggle Panel");
			}
		}

		clampVisibleParts();
		previous = current;
	}

	function schedule() {
		if (!pending) {
			pending = true;
			window.requestAnimationFrame(enforce);
		}
	}

	function scheduleAfterInteraction() {
		for (const pass of latePasses) {
			window.clearTimeout(pass);
		}
		latePasses = [];

		schedule();
		window.requestAnimationFrame(schedule);
		latePasses.push(window.setTimeout(schedule, 120));
		latePasses.push(window.setTimeout(schedule, 360));
	}

	new MutationObserver(schedule).observe(document.documentElement, {
		attributes: true,
		childList: true,
		subtree: true,
	});

	document.addEventListener("click", scheduleAfterInteraction, true);
	window.addEventListener("popstate", handleOverlayBack);
	window.addEventListener("resize", schedule);
	narrow.addEventListener("change", schedule);

	window.setTimeout(schedule, 500);
	window.setTimeout(schedule, 1500);
})();
