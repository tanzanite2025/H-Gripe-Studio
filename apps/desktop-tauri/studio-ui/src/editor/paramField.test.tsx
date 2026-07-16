// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import { ParamField } from "./ParamField";
import type { ParamSpec } from "../graph/nodeSpecs";

const engineSpec: ParamSpec = {
  key: "engine",
  label: "Engine",
  control: "select",
  options: ["builtin", "unavailable"],
  defaultValue: "rules",
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ParamField select option states", () => {
  it("disables options the probe reports as unavailable", () => {
    const { container } = render(
      <ParamField
        spec={engineSpec}
        value="rules"
        onChange={() => {}}
        optionStates={{
          rules: { available: true, reason: "built-in CPU rule layer" },
          unavailable: { available: false, reason: "feature is not available" },
        }}
      />,
    );
    const options = Array.from(container.querySelectorAll("option"));
    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    expect(byValue.builtin.disabled).toBe(false);
    expect(byValue.unavailable.disabled).toBe(true);
    expect(byValue.unavailable.title).toContain("not available");
  });

  it("leaves every option enabled when no probe states are provided", () => {
    const { container } = render(
      <ParamField spec={engineSpec} value="rules" onChange={() => {}} />,
    );
    const options = Array.from(container.querySelectorAll("option"));
    expect(options.every((o) => !o.disabled)).toBe(true);
  });
});
