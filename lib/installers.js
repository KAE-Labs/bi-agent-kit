import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Per-binary install commands, keyed by process.platform.
 *
 * pac (Power Platform CLI) and dab (Data API Builder CLI) both ship as
 * .NET global tools, so the dotnet-tool install command is identical across
 * platforms as long as the .NET SDK is present. uv/uvx has no dotnet
 * equivalent and instead ships a platform-specific standalone installer
 * script (astral.sh).
 */
export const INSTALLERS = {
  pac: {
    label: "Power Platform CLI (pac)",
    docs: "https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction",
    commands: {
      win32: { command: "dotnet", args: ["tool", "install", "--global", "Microsoft.PowerApps.CLI.Tool"] },
      darwin: { command: "dotnet", args: ["tool", "install", "--global", "Microsoft.PowerApps.CLI.Tool"] },
      linux: { command: "dotnet", args: ["tool", "install", "--global", "Microsoft.PowerApps.CLI.Tool"] },
    },
  },
  dab: {
    label: "Data API Builder CLI (dab)",
    docs: "https://learn.microsoft.com/en-us/azure/data-api-builder/how-to-install-cli",
    commands: {
      win32: { command: "dotnet", args: ["tool", "install", "--global", "Microsoft.DataApiBuilder"] },
      darwin: { command: "dotnet", args: ["tool", "install", "--global", "Microsoft.DataApiBuilder"] },
      linux: { command: "dotnet", args: ["tool", "install", "--global", "Microsoft.DataApiBuilder"] },
    },
  },
  uvx: {
    label: "uv / uvx",
    docs: "https://docs.astral.sh/uv/getting-started/installation/",
    commands: {
      win32: { command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"] },
      darwin: { command: "sh", args: ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"] },
      linux: { command: "sh", args: ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"] },
    },
  },
};

async function defaultRunner(command, args) {
  await execFileAsync(command, args);
}

/**
 * Offers to install a missing prerequisite binary, running the platform
 * appropriate command only after the caller-supplied confirm() resolves
 * truthy. Accepts an injectable `runner(command, args)` so tests never
 * actually shell out.
 *
 * Returns { attempted, installed, reason?, message? }.
 */
export async function offerInstall(binaryName, { confirm, runner, platform = process.platform } = {}) {
  const installer = INSTALLERS[binaryName];
  if (!installer) {
    return { attempted: false, installed: false, reason: "no-installer" };
  }
  const commandSpec = installer.commands[platform];
  if (!commandSpec) {
    return { attempted: false, installed: false, reason: "unsupported-platform" };
  }
  const proceed = await confirm({ message: "Install " + installer.label + " now?" });
  if (!proceed) {
    return { attempted: false, installed: false, reason: "declined" };
  }
  const run = runner || defaultRunner;
  try {
    await run(commandSpec.command, commandSpec.args);
    return { attempted: true, installed: true };
  } catch (err) {
    return { attempted: true, installed: false, reason: "error", message: err.message };
  }
}
