import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const MAX_SOURCE_LINES = 800;

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "web-react/dist/**",
      "tools/**",
      "tool-packages/**",
      "coverage/**",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "web-react/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/exhaustive-deps": "off",
      "max-lines": [
        "error",
        {
          max: MAX_SOURCE_LINES,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
  },
);
