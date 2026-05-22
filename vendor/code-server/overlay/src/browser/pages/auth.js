(() => {
	const href = document.getElementById("href")
	if (href) {
		href.value = location.href
	}

	for (const input of document.querySelectorAll(".monaco-inputbox > .ibwrapper > .input")) {
		const inputBox = input.closest(".monaco-inputbox")
		input.classList.toggle("empty", !input.value)
		input.addEventListener("focus", () => inputBox?.classList.add("synthetic-focus"))
		input.addEventListener("blur", () => inputBox?.classList.remove("synthetic-focus"))
		input.addEventListener("input", () => input.classList.toggle("empty", !input.value))
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault()
				input.form?.requestSubmit()
			}
		})
	}
})()
