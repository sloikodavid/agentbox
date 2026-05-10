import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const tsFiles = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

export default defineConfig(
	globalIgnores(["coverage/", "rootfs/home/user/.local/share/code-server/"]),
	{
		linterOptions: {
			reportUnusedDisableDirectives: "error",
		},
	},
	js.configs.recommended,
	{
		files: tsFiles,
		extends: [tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
		},
	},
	{
		files: ["*.mjs", "scripts/**/*.mjs"],
		languageOptions: {
			globals: {
				console: "readonly",
				process: "readonly",
			},
		},
	},
);
