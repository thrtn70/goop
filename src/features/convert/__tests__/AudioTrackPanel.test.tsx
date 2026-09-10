import { cleanup, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AudioProbeDetails, TrackIdentity, TrackSettingsCapabilities } from "@/types";
import AudioTrackPanel from "../AudioTrackPanel";

const fact = (value: string) => ({ kind: "value" as const, value });
const identity = (
  index: number,
  language: TrackIdentity["language"],
  title: TrackIdentity["title"],
): TrackIdentity => ({
  index,
  codec_type: "audio",
  codec_name: fact("aac"),
  container_stream_id: { kind: "missing" },
  language,
  title,
  disposition: {
    default: index === 1,
    forced: index === 2,
    attached_pic: false,
    other: {},
    malformed: false,
  },
});
const tracks = [
  identity(1, fact("eng"), fact("Main")),
  identity(2, fact("eng"), fact("Commentary")),
  identity(3, { kind: "missing" }, { kind: "malformed" }),
];
const settings: TrackSettingsCapabilities = {
  source: {
    version: 1,
    canonical_path: "/movie.mkv",
    size_bytes: "10",
    modified_unix_ns: "20",
    inventory: { version: 1, streams: tracks },
  },
  audio_choices: tracks.map((track) => ({
    track,
    copy: track.index === 2
      ? { available: false, reason: "Commentary cannot be copied" }
      : { available: true },
    encode: { available: true },
  })),
};
const details: AudioProbeDetails = {
  has_non_audio_streams: true,
  streams: [
    { index: 1, channels: { kind: "exact", value: 2 } },
    { index: 2, channels: { kind: "exact", value: 1 } },
    { index: 3 },
  ],
};

afterEach(cleanup);

it("shows duplicate and missing identity facts plus channel/default/forced badges", () => {
  render(<AudioTrackPanel settings={settings} audioDetails={details} mode="encode" value={null} onChange={() => {}} />);
  expect(screen.getAllByText("English")).toHaveLength(2);
  expect(screen.getByText("Language not reported")).toBeDefined();
  expect(screen.getByText("Title malformed")).toBeDefined();
  expect(screen.getAllByText("AAC")).toHaveLength(3);
  expect(screen.getByText("2 channels")).toBeDefined();
  expect(screen.getByText("1 channel")).toBeDefined();
  expect(screen.getByText("Channels not reported")).toBeDefined();
  expect(screen.getByText("Default")).toBeDefined();
  expect(screen.getByText("Forced")).toBeDefined();
});

it("keeps selection disabled in Automatic and explains how to enable it", () => {
  render(<AudioTrackPanel settings={settings} audioDetails={details} mode="automatic" value={null} onChange={() => {}} />);
  expect(screen.getByText("Choose Copy audio or Custom encode to select a track.")).toBeDefined();
  for (const option of screen.getAllByRole("radio")) expect(option).toHaveProperty("disabled", true);
});

it("hides a retained explicit draft when switching to Automatic", () => {
  const value = { kind: "audio" as const, source: settings.source, stream_index: 2 };
  const { rerender } = render(
    <AudioTrackPanel settings={settings} audioDetails={details} mode="copy" value={value} onChange={() => {}} />,
  );
  expect(screen.getByRole("radio", { name: /commentary/i })).toHaveProperty("checked", true);

  rerender(
    <AudioTrackPanel settings={settings} audioDetails={details} mode="automatic" value={value} onChange={() => {}} />,
  );
  expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
  expect(screen.queryByText(/source changed after track selection/i)).toBeNull();

  rerender(
    <AudioTrackPanel settings={settings} audioDetails={details} mode="copy" value={value} onChange={() => {}} />,
  );
  expect(screen.getByRole("radio", { name: /commentary/i })).toHaveProperty("checked", true);
});

it("selects by absolute stream index and exposes the selected-mode reason", async () => {
  const onChange = vi.fn();
  render(<AudioTrackPanel settings={settings} audioDetails={details} mode="copy" value={null} onChange={onChange} />);
  const commentary = screen.getByRole("radio", { name: /commentary/i });
  expect(commentary).toHaveProperty("disabled", true);
  expect(screen.getByText("Commentary cannot be copied")).toBeDefined();
  await userEvent.click(screen.getByRole("radio", { name: /main/i }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "audio", stream_index: 1 }));
});

it("renders a sole explicit choice as selected without an extra interaction", () => {
  render(<AudioTrackPanel settings={{ ...settings, audio_choices: [settings.audio_choices[0]] }} audioDetails={details} mode="copy" value={null} onChange={() => {}} />);
  expect(screen.getByRole("radio", { name: /main/i })).toHaveProperty("checked", true);
});

it("makes a changed-source plan failure actionable", async () => {
  const onReinspect = vi.fn();
  render(<AudioTrackPanel
    settings={settings}
    audioDetails={details}
    mode="copy"
    value={{ kind: "audio", source: settings.source, stream_index: 1 }}
    planError="The source changed after track selection; reinspect it"
    onChange={() => {}}
    onReinspect={onReinspect}
  />);
  expect(screen.getByRole("alert").textContent).toMatch(/source changed/i);
  await userEvent.click(screen.getByRole("button", { name: "Reinspect source" }));
  expect(onReinspect).toHaveBeenCalledOnce();
});

it("keeps each rendered panel in an independent native radio group", async () => {
  const secondSettings: TrackSettingsCapabilities = {
    ...settings,
    source: { ...settings.source, canonical_path: "/second.mkv" },
    audio_choices: settings.audio_choices.map((choice) => ({
      ...choice,
      track: {
        ...choice.track,
        title: fact(`Second ${choice.track.index}`),
      },
    })),
  };
  function TwoPanels() {
    const [first, setFirst] = useState({
      kind: "audio" as const,
      source: settings.source,
      stream_index: 1,
    });
    const [second, setSecond] = useState({
      kind: "audio" as const,
      source: secondSettings.source,
      stream_index: 1,
    });
    return <>
      <AudioTrackPanel settings={settings} audioDetails={details} mode="encode" value={first} onChange={setFirst} />
      <AudioTrackPanel settings={secondSettings} audioDetails={details} mode="encode" value={second} onChange={setSecond} />
    </>;
  }

  render(<TwoPanels />);
  const [firstPanel, secondPanel] = screen.getAllByRole("region", { name: "Audio track" });
  const firstMain = within(firstPanel).getByRole("radio", { name: /main/i });
  const secondChoice = within(secondPanel).getByRole("radio", { name: /second 2/i });
  expect(firstMain).toHaveProperty("checked", true);
  expect(firstMain.getAttribute("name")).not.toBe(secondChoice.getAttribute("name"));
  await userEvent.click(secondChoice);
  expect(firstMain).toHaveProperty("checked", true);
  expect(secondChoice).toHaveProperty("checked", true);
});

it("keeps technical details outside the radio label", () => {
  render(<AudioTrackPanel settings={settings} audioDetails={details} mode="encode" value={null} onChange={() => {}} />);
  const main = screen.getByRole("radio", { name: /main/i });
  const label = document.querySelector(`label[for="${main.id}"]`);
  expect(label).not.toBeNull();
  expect(label?.querySelector("details")).toBeNull();
});
