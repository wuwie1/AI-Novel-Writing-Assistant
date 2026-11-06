import path from "node:path";
import type { Config } from "tailwindcss";
import clientTheme from "../../client/tailwind.config";

export default {
  ...clientTheme,
  content: [path.resolve(__dirname, "index.html"), path.resolve(__dirname, "src/**/*.{ts,tsx}"), path.resolve(__dirname, "../../client/src/**/*.{ts,tsx}")],
} satisfies Config;
