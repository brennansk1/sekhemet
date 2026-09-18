// Placeholder, replaced below.
import { setTopbar } from "./shell.js";
export function mount(view) {
  setTopbar({ title: "integrations" });
  return { unmount() {} };
}
