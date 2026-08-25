import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detect } from "../src/detect.ts";
import { extract } from "../src/extract.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createCSharpProject(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-mindplace-csharp-"));
  temporaryDirectories.push(root);
  writeFileSync(
    join(root, "Greeter.cs"),
    `
using System;
namespace Demo.Services;
[Obsolete]
public record User(string Name);
public interface IGreeter { string Greet(User user); }
public class Greeter : IGreeter {
  public string Name { get; set; }
  public event EventHandler? Changed;
  public Greeter(string name) { Name = name; }
  public string Greet(User user) { Changed?.Invoke(this, EventArgs.Empty); return user.Name; }
}
public delegate void ChangedHandler(object sender);
`,
    "utf-8",
  );
  writeFileSync(
    join(root, "Program.cs"),
    'System.Console.WriteLine("hello");',
    "utf-8",
  );
  return root;
}

describe("C# extraction", () => {
  it("detects C# files and extracts modern declaration and relationship nodes", () => {
    const root = createCSharpProject();
    const detected = detect(root);
    const result = extract(root, detected.files);

    assert.deepEqual(detected.files, ["Greeter.cs", "Program.cs"]);
    assert.ok(
      result.nodes.some(
        (node) => node.type === "namespace" && node.label === "Demo.Services",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) => node.type === "record" && node.label === "Demo.Services.User",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "attribute" &&
          node.label.startsWith("Demo.Services.User.Obsolete@L"),
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "interface" && node.label === "Demo.Services.IGreeter",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "class" && node.label === "Demo.Services.Greeter",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "property" &&
          node.label === "Demo.Services.Greeter.Name",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "event" &&
          node.label === "Demo.Services.Greeter.Changed",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "constructor" &&
          node.label === "Demo.Services.Greeter.Greeter",
      ),
    );
    assert.ok(
      result.nodes.some(
        (node) =>
          node.type === "delegate" &&
          node.label === "Demo.Services.ChangedHandler",
      ),
    );
    assert.ok(result.nodes.some((node) => node.type === "top-level-statement"));
    assert.ok(result.edges.some((edge) => edge.relation === "imports"));
    assert.ok(result.edges.some((edge) => edge.relation === "inherits"));
    assert.ok(result.edges.some((edge) => edge.relation === "calls"));
  });
});
