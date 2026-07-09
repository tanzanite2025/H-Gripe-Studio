// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildExportFramePath,
  ExportFrameDialog,
} from "./ExportFrameDialog";

vi.mock("../bridge/files", () => ({
  getRuntimeOutputDir: vi.fn(async () => "C:\\exports"),
  pickFolder: vi.fn(async () => null),
}));

describe("ExportFrameDialog", () => {
  it("exports a BMP frame and adds it to the project by default", async () => {
    const onExport = vi.fn(async ({ path, format }) => ({
      path,
      width: 1920,
      height: 1080,
      format,
    }));
    const onAddToProject = vi.fn();

    render(
      <ExportFrameDialog
        defaultName="frame_00-00-01-00"
        onClose={() => {}}
        onExport={onExport}
        onAddToProject={onAddToProject}
      />,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("C:\\exports"),
    );
    expect((screen.getByLabelText("Add to Project") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() =>
      expect(onExport).toHaveBeenCalledWith({
        path: "C:\\exports\\frame_00-00-01-00.bmp",
        format: "bmp",
      }),
    );
    expect(onAddToProject).toHaveBeenCalledWith({
      path: "C:\\exports\\frame_00-00-01-00.bmp",
      name: "frame_00-00-01-00",
    });
  });

  it("builds a clean target path from name, directory, and format", () => {
    expect(buildExportFramePath("/tmp/out/", "hero:shot.png", "jpeg")).toBe("/tmp/out/hero-shot.jpg");
  });
});
