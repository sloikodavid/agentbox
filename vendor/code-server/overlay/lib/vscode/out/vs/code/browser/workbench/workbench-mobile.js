(function () {
	const narrow = window.matchMedia("(max-width: 600px)");
	const touchLike = window.matchMedia("(hover: none), (any-pointer: coarse)");
	let previous = null;
	let pending = false;
	let latePasses = [];
	let overlayBackGuardArmed = false;
	let overlayBackGuardDisarming = false;
	let horizontalPan = null;
	let horizontalScrollbarDrag = null;
	const modalEditorMobileAttribute = "data-agentbox-mobile-maximized";
	const modalEditorMaximizePendingAttribute =
		"data-agentbox-mobile-maximize-pending";

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
	const keybindingsTableContainerSelector = ".keybindings-table-container";
	const keybindingsScrollSelector =
		`.keybindings-editor > .keybindings-body > ${keybindingsTableContainerSelector}`;
	const horizontalPanSelectors = [
		".settings-editor .monaco-split-view2.horizontal > .monaco-scrollable-element > .split-view-container",
		".profiles-editor > .monaco-split-view2.horizontal > .monaco-scrollable-element > .split-view-container",
		keybindingsScrollSelector,
	];
	const modalEditorMaximizeSelector =
		".monaco-modal-editor-block .modal-editor-action-container .action-label.codicon-screen-full";

	function browserPinchWheel(event) {
		return (
			event.ctrlKey &&
			!event.metaKey &&
			!event.shiftKey &&
			!event.altKey
		);
	}

	function releaseBrowserZoomGesture(event) {
		if (browserPinchWheel(event)) {
			event.stopPropagation();
		}
	}

	function maxScrollLeft(container) {
		return Math.max(0, container.scrollWidth - container.clientWidth);
	}

	function setScrollLeft(container, scrollLeft) {
		const nextScrollLeft = Math.max(
			0,
			Math.min(maxScrollLeft(container), scrollLeft),
		);

		if (container.scrollLeft !== nextScrollLeft) {
			container.scrollLeft = nextScrollLeft;
			updateKeybindingsScrollbar(container);
			return true;
		}

		return false;
	}

	function keybindingsScrollContainer(target) {
		if (!(target instanceof Element)) {
			return null;
		}

		const container = target.closest(keybindingsScrollSelector);
		return container instanceof HTMLElement ? container : null;
	}

	function ensureKeybindingsScrollbar(container) {
		const body = container.parentElement;
		if (!(body instanceof HTMLElement)) {
			return null;
		}

		let scrollbar = body.querySelector(":scope > .agentbox-keybindings-scrollbar");
		if (scrollbar instanceof HTMLElement) {
			return scrollbar;
		}

		scrollbar = document.createElement("div");
		scrollbar.className =
			"agentbox-keybindings-scrollbar scrollbar horizontal";
		scrollbar.setAttribute("role", "presentation");
		scrollbar.setAttribute("aria-hidden", "true");

		const slider = document.createElement("div");
		slider.className = "slider";
		scrollbar.append(slider);
		body.append(scrollbar);

		return scrollbar;
	}

	function updateKeybindingsScrollbar(container) {
		if (!container.matches(keybindingsScrollSelector)) {
			return;
		}

		const scrollbar = ensureKeybindingsScrollbar(container);
		if (!scrollbar) {
			return;
		}

		const slider = scrollbar.querySelector(":scope > .slider");
		if (!(slider instanceof HTMLElement)) {
			return;
		}

		const maxLeft = maxScrollLeft(container);
		if (maxLeft <= 1 || container.clientWidth <= 0) {
			scrollbar.classList.add("hidden");
			return;
		}

		scrollbar.classList.remove("hidden");
		const trackWidth = container.clientWidth;
		const sliderWidth = Math.max(
			20,
			Math.round((trackWidth / container.scrollWidth) * trackWidth),
		);
		const sliderLeft = Math.round(
			(container.scrollLeft / maxLeft) * (trackWidth - sliderWidth),
		);

		slider.style.width = `${sliderWidth}px`;
		slider.style.transform = `translate3d(${sliderLeft}px, 0, 0)`;
	}

	function updateKeybindingsScrollbars() {
		for (const container of document.querySelectorAll(keybindingsScrollSelector)) {
			if (container instanceof HTMLElement) {
				updateKeybindingsScrollbar(container);
			}
		}
	}

	function handleHorizontalWheel(event) {
		if (browserPinchWheel(event)) {
			return;
		}

		const absX = Math.abs(event.deltaX);
		const absY = Math.abs(event.deltaY);
		if (absX <= absY || absX < 1) {
			return;
		}

		const container = keybindingsScrollContainer(event.target);
		if (!container || maxScrollLeft(container) <= 1) {
			return;
		}

		if (setScrollLeft(container, container.scrollLeft + event.deltaX)) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function mobileTouchLayout() {
		return narrow.matches && touchLike.matches;
	}

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

	function interactiveTarget(element) {
		return Boolean(
			element.closest(
				[
					".scrollbar",
					"a",
					"button",
					"input",
					"select",
					"textarea",
					"[contenteditable='true']",
					"[role='button']",
					"[role='checkbox']",
					"[role='radio']",
					".monaco-button",
					".action-label",
				].join(","),
			),
		);
	}

	function horizontalPanContainer(target) {
		if (!mobileTouchLayout() || !(target instanceof Element)) {
			return null;
		}

		if (interactiveTarget(target)) {
			return null;
		}

		const selector = horizontalPanSelectors.join(",");
		const container = target.closest(selector);
		if (!(container instanceof HTMLElement)) {
			return null;
		}

		if (container.scrollWidth <= container.clientWidth + 1) {
			return null;
		}

		return container;
	}

	function startHorizontalPan(event) {
		if (event.pointerType === "mouse" || event.button !== 0) {
			return;
		}

		const container = horizontalPanContainer(event.target);
		if (!container) {
			return;
		}

		horizontalPan = {
			container,
			dragging: false,
			pointerId: event.pointerId,
			scrollLeft: container.scrollLeft,
			x: event.clientX,
			y: event.clientY,
		};
	}

	function startHorizontalScrollbarDrag(event) {
		if (event.button !== 0 || !(event.target instanceof Element)) {
			return;
		}

		const slider = event.target.closest(
			".agentbox-keybindings-scrollbar > .slider",
		);
		if (!(slider instanceof HTMLElement)) {
			return;
		}

		const scrollbar = slider.closest(".agentbox-keybindings-scrollbar");
		const container = scrollbar?.parentElement?.querySelector(
			`:scope > ${keybindingsTableContainerSelector}`,
		);
		if (!(container instanceof HTMLElement) || !(scrollbar instanceof HTMLElement)) {
			return;
		}

		horizontalScrollbarDrag = {
			container,
			pointerId: event.pointerId,
			scrollLeft: container.scrollLeft,
			slider,
			trackWidth: scrollbar.clientWidth,
			sliderWidth: slider.offsetWidth,
			x: event.clientX,
		};
		slider.classList.add("active");
		event.preventDefault();
		event.stopPropagation();
	}

	function updateHorizontalPan(event) {
		if (!horizontalPan || event.pointerId !== horizontalPan.pointerId) {
			return;
		}

		const deltaX = event.clientX - horizontalPan.x;
		const deltaY = event.clientY - horizontalPan.y;
		const absX = Math.abs(deltaX);
		const absY = Math.abs(deltaY);

		if (!horizontalPan.dragging) {
			if (absY > absX && absY > 8) {
				horizontalPan = null;
				return;
			}

			if (absX < 8 || absX <= absY) {
				return;
			}

			horizontalPan.dragging = true;
		}

		const { container } = horizontalPan;
		if (setScrollLeft(container, horizontalPan.scrollLeft - deltaX)) {
			container.dispatchEvent(new Event("scroll"));
		}

		event.preventDefault();
		event.stopPropagation();
	}

	function updateHorizontalScrollbarDrag(event) {
		if (
			!horizontalScrollbarDrag ||
			event.pointerId !== horizontalScrollbarDrag.pointerId
		) {
			return;
		}

		const {
			container,
			scrollLeft,
			sliderWidth,
			trackWidth,
			x,
		} = horizontalScrollbarDrag;
		const maxLeft = maxScrollLeft(container);
		const maxSliderLeft = Math.max(1, trackWidth - sliderWidth);
		const nextScrollLeft = scrollLeft + ((event.clientX - x) / maxSliderLeft) * maxLeft;

		setScrollLeft(container, nextScrollLeft);
		event.preventDefault();
		event.stopPropagation();
	}

	function stopHorizontalPan(event) {
		if (horizontalPan?.pointerId === event.pointerId) {
			horizontalPan = null;
		}
	}

	function stopHorizontalScrollbarDrag(event) {
		if (horizontalScrollbarDrag?.pointerId === event.pointerId) {
			horizontalScrollbarDrag.slider.classList.remove("active");
			horizontalScrollbarDrag = null;
		}
	}

	function handleKeybindingsScroll(event) {
		if (event.target instanceof HTMLElement) {
			updateKeybindingsScrollbar(event.target);
		}
	}

	function updateModalEditorMobileState() {
		for (const action of document.querySelectorAll(modalEditorMaximizeSelector)) {
			if (!(action instanceof HTMLElement)) {
				continue;
			}

			const modal = action.closest(".monaco-modal-editor-block");
			if (!(modal instanceof HTMLElement)) {
				continue;
			}

			if (!narrow.matches) {
				modal.removeAttribute(modalEditorMobileAttribute);
				modal.removeAttribute(modalEditorMaximizePendingAttribute);
				continue;
			}

			const maximized = action.getAttribute("aria-pressed") === "true";
			if (maximized) {
				modal.setAttribute(modalEditorMobileAttribute, "true");
				modal.removeAttribute(modalEditorMaximizePendingAttribute);
				continue;
			}

			if (modal.getAttribute(modalEditorMaximizePendingAttribute) !== "true") {
				modal.setAttribute(modalEditorMaximizePendingAttribute, "true");
				modal.setAttribute(modalEditorMobileAttribute, "true");
				action.click();
			}
		}
	}

	function blockMobileModalEditorRestore(event) {
		if (!narrow.matches || !(event.target instanceof Element)) {
			return;
		}

		if (event.target.closest(".monaco-modal-editor-block .modal-editor-header")) {
			event.preventDefault();
			event.stopPropagation();
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
		const width = Math.max(0, Math.floor(window.innerWidth - rect.left));
		part.style.width = `${width}px`;
		splitView.style.width = `${width}px`;
	}

	function clampVisibleParts() {
		clampPart(".part.panel");
	}

	function enforce() {
		pending = false;
		updateOverlayBackGuard();
		updateKeybindingsScrollbars();
		updateModalEditorMobileState();

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

	function handleNarrowChange() {
		updateModalEditorMobileState();
		schedule();
	}

	new MutationObserver(schedule).observe(document.documentElement, {
		attributes: true,
		childList: true,
		subtree: true,
	});

	document.addEventListener("click", scheduleAfterInteraction, true);
	document.addEventListener("dblclick", blockMobileModalEditorRestore, true);
	document.addEventListener("scroll", handleKeybindingsScroll, true);
	document.addEventListener("pointerdown", startHorizontalScrollbarDrag, true);
	document.addEventListener("pointerdown", startHorizontalPan, true);
	document.addEventListener("pointermove", updateHorizontalScrollbarDrag, {
		capture: true,
		passive: false,
	});
	document.addEventListener("pointermove", updateHorizontalPan, {
		capture: true,
		passive: false,
	});
	document.addEventListener("pointerup", stopHorizontalScrollbarDrag, true);
	document.addEventListener("pointerup", stopHorizontalPan, true);
	document.addEventListener("pointercancel", stopHorizontalScrollbarDrag, true);
	document.addEventListener("pointercancel", stopHorizontalPan, true);
	window.addEventListener("wheel", (event) => {
		releaseBrowserZoomGesture(event);
		handleHorizontalWheel(event);
	}, {
		capture: true,
		passive: false,
	});
	window.addEventListener("popstate", handleOverlayBack);
	window.addEventListener("resize", schedule);
	narrow.addEventListener("change", handleNarrowChange);
	touchLike.addEventListener("change", schedule);

	window.setTimeout(schedule, 500);
	window.setTimeout(schedule, 1500);
})();
