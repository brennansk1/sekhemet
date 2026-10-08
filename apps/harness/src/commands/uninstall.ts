import { installInventory } from "../install_inventory.js";
import { REMOVE_PACKAGE_LINE, inventoryLines, uninstall } from "../uninstall.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet uninstall --dry-run | --yes [--include-ledgers]` (surface item
 * 33, NEW-surface-7, SUR-58, SUR-59). Listed under `sekhemet dev --help`
 * (rule 14). With neither flag it lists, as `--dry-run` does, and removes
 * nothing.
 */
export const uninstallCommand: CommandHandler = async (args) => {
  const dry = args.values["dry-run"] === true;
  const yes = args.values.yes === true;
  const includeLedgers = args.values["include-ledgers"] === true;
  if (dry && yes) {
    console.error(
      "sekhemet: --dry-run lists and --yes removes; give one: sekhemet uninstall --dry-run | --yes",
    );
    return 2;
  }
  if (!yes) {
    for (const l of inventoryLines(installInventory(), includeLedgers)) console.log(l);
    console.log(
      dry
        ? "Nothing was changed (--dry-run)."
        : "Nothing was changed: `sekhemet uninstall --yes` removes these.",
    );
    console.log(`The package itself is removed with: ${REMOVE_PACKAGE_LINE}`);
    return 0;
  }
  console.log("Removing what this install wrote outside its package:");
  const failed = uninstall(includeLedgers);
  if (!includeLedgers)
    console.log(
      "Each project's ledger and every backup were kept (--include-ledgers removes them).",
    );
  console.log(`Now remove the package itself: ${REMOVE_PACKAGE_LINE}`);
  return failed === 0 ? 0 : 1;
};
