// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ViewportBackendBadge } from "./ViewportBackendBadge";

describe("ViewportBackendBadge", () => {
  it("renders nothing without a backend report", () => {
    const { container } = render(<ViewportBackendBadge backend={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the used device with the full report as tooltip", () => {
    const { getByTitle } = render(
      <ViewportBackendBadge backend={{ requested: "auto", actual: "wgpu" }} />,
    );
    const badge = getByTitle("device auto -> wgpu");
    expect(badge.textContent).toBe("wgpu");
  });

  it("marks a fallback frame and carries the reason in the tooltip", () => {
    const { getByTitle } = render(
      <ViewportBackendBadge
        backend={{ requested: "auto", actual: "cpu", fallback_reason: "no adapter" }}
      />,
    );
    const badge = getByTitle("device auto -> cpu (fallback: no adapter)");
    expect(badge.textContent).toBe("cpu ⚠");
  });
});
