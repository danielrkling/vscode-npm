import { parseTarGzip } from "nanotar";
import { maxSatisfying } from "semver";
import {
  commands,
  ExtensionContext,
  window,
  workspace,
  Uri,
  OutputChannel,
  FileSystemWatcher,
} from "vscode";

let initialized = false;
let outputWindow: OutputChannel;

const node_modules = Uri.joinPath(
  workspace.workspaceFolders![0].uri,
  "node_modules"
);

export async function activate(context: ExtensionContext) {
  if (!initialized) {
    initialized = true;
    outputWindow = window.createOutputChannel("npm");
    outputWindow.show();
  }

  commands.registerCommand("vscode-npm.install", async () => {
    const input = await window.showInputBox({
      prompt: "Enter the NPM package name to install",
    });

    if (!input) {
      outputWindow.appendLine("No package name provided.");
      return;
    }

    const [packageName, version] = parseNpmPackage(input);

    installPackage(packageName, version);
  });

  commands.registerCommand("vscode-npm.install-package-json", async () => {
    const meta = JSON.parse(
      await workspace.decode(
        await workspace.fs.readFile(
          Uri.joinPath(workspace.workspaceFolders![0].uri, "package.json")
        )
      )
    );

    for (const dep of Object.keys(meta.dependencies || {})) {
      const depVersion = meta.dependencies[dep];
      await installPackage(dep, depVersion); // Remove leading caret or tilde
    }
  });
}

function parseNpmPackage(packageNameString: string): [string, string] {
  // Regular expression to match package name and optional version.
  // It handles both unscoped and scoped packages.
  // Group 1: Full package name (e.g., "lodash", "@angular/core")
  // Group 2: Optional version (e.g., "18.2.0", "latest")
  const regex = /^(?:@([^/]+)\/)?([^@]+)(?:@(.+))?$/;
  const match = packageNameString.match(regex);

  if (!match) {
    // If the string doesn't match the expected format, throw an error or return a default.
    // For this example, we'll throw an error as it indicates an invalid input.
    throw new Error(
      `Invalid npm package string format: "${packageNameString}"`
    );
  }

  const scope = match[1]; // The scope part (e.g., "angular" for "@angular/core")
  const name = match[2]; // The base name (e.g., "core" for "@angular/core", "lodash" for "lodash")
  const version = match[3] || "latest"; // The version, defaults to 'latest' if not provided.

  // Reconstruct the full package name for scoped packages.
  const fullPackageName = scope ? `@${scope}/${name}` : name;

  return [fullPackageName, version];
}

const installedPackages: Set<string> = new Set();

async function installPackage(
  packageName: string,
  versionRange: string
): Promise<void> {
  const meta = await fetch(`https://registry.npmjs.org/${packageName}`).then(
    (response) => response.json()
  );

  if (meta["dist-tags"][versionRange]) {
    versionRange = meta["dist-tags"][versionRange];
  }

  const version = maxSatisfying(
    Object.keys(meta.versions),
    versionRange
  ) as unknown as string;

  if (installedPackages.has(`${packageName}@${version}`)) return;
  installedPackages.add(`${packageName}@${version}`);
  outputWindow.appendLine(`Installing package: ${packageName} ${version}`);

  const tarballUrl = meta.versions[version].dist.tarball;

  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    outputWindow.appendLine(
      `Failed to download package: ${packageName} ${version}`
    );
    return;
  }

  await workspace.fs.createDirectory(node_modules);

  const files = await parseTarGzip(await tarballResponse.arrayBuffer());

  for (const file of files) {
    const uri = Uri.joinPath(node_modules, packageName, file.name.slice(8));

    if (file.type === "directory") {
      await workspace.fs.createDirectory(uri);
    } else if (file.type === "file") {
      await workspace.fs.writeFile(uri, file.data!);
    }
  }

  for (const dep of Object.keys(meta.versions[version].dependencies || {})) {
    const depVersion = meta.versions[version].dependencies[dep];
    await installPackage(dep, depVersion); // Remove leading caret or tilde
  }
}
