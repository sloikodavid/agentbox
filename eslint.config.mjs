import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

export default defineConfig(
	globalIgnores([
		"coverage/",
		"tmp/",
		"vendor/",
		"rootfs/home/user/.local/share/code-server/"
	]),
	{
		linterOptions: {
			reportUnusedDisableDirectives: "error"
		}
	},
	js.configs.recommended,
	{
		files: TS_FILES,
		extends: [tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error"
		}
	},
	{
		files: ["*.mjs", "scripts/**/*.mjs"],
		languageOptions: {
			globals: {
				console: "readonly",
				process: "readonly"
			}
		}
	}
);
