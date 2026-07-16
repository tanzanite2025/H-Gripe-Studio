// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { NodeDeviceBadge } from "./NodeDeviceBadge";

describe("NodeDeviceBadge", () => {
  it("renders nothing without a report", () => {
    const { container } = render(<NodeDeviceBadge report={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the used device with the full report as tooltip", () => {
    const { getByTitle } = render(
      <NodeDeviceBadge
        report={{ requested: "auto", used: "cuda", backend: "native image kernel", accelerated: true }}
      />,
    );
    const badge = getByTitle("device auto -> cuda (native image kernel)");
    expect(badge.textContent).toBe("cuda");
  });

  it("marks a fallback run and carries the reason in the tooltip", () => {
    const { getByTitle } = render(
      <NodeDeviceBadge
        report={{
          requested: "cuda",
          used: "cpu",
          accelerated: false,
          fallbackReason: "CUDA provider unavailable",
        }}
      />,
    );
    const badge = getByTitle("device cuda -> cpu (fallback: CUDA provider unavailable)");
    expect(badge.textContent).toBe("cpu ⚠");
  });
});
