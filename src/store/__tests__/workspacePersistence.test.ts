import { describe, expect, it } from "vitest";
import { decodeDraftEntries, encodeDraftEntries, loadDraftEntries, saveDraftEntries } from "../workspacePersistence";
const key = (slot: string) => JSON.stringify(["image", slot]);
describe("durable editable drafts", () => {
  it("roundtrips editable source lists and app-icon sets", () => {
    const entries = { [key("ImagePage.files")]: {value:["/photo.png"]},
      [key("ImageAppIconFlow.selected")]: {value:new Set(["macos", "windows"])} };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual(entries);
  });
  it("rejects corruption, unknown versions and oversized snapshots", () => {
    expect(decodeDraftEntries("{")).toEqual({});
    expect(decodeDraftEntries('{"version":99,"entries":{}}')).toEqual({});
    expect(decodeDraftEntries("x".repeat(524289))).toEqual({});
  });
  it("drops malformed file lists and unknown runtime slots independently", () => {
    const raw = JSON.stringify({version:1, entries:{
      [key("ImagePage.files")]:{value:[null]},
      [key("ImageRotateFlow.degrees")]:{value:"cw90"},
      [key("Runtime.promise")]:{value:{}},
    }});
    expect(decodeDraftEntries(raw)).toEqual({[key("ImageRotateFlow.degrees")]:{value:"cw90"}});
  });
  it("persists removal without resurrecting older files", () => {
    const values=new Map<string,string>();
    const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
    expect(saveDraftEntries(storage,{[key("ImagePage.files")]:{value:["/a.png"]}})).toBe(true);
    expect(saveDraftEntries(storage,{})).toBe(true);
    expect(loadDraftEntries(storage)).toEqual({});
  });
  it("handles unavailable storage without losing in-memory state", () => {
    const storage={getItem:()=>{throw Error("unavailable");},setItem:()=>{throw Error("quota");}};
    expect(loadDraftEntries(storage)).toEqual({});
    expect(saveDraftEntries(storage,{})).toBe(false);
  });
});

describe("JPEG draft persistence", () => {
  const fileKey = JSON.stringify(["convert", "ConvertPage.files"]);
  const file = { id: "photo-1", revision: 2, path: "/photo.jpg", sourceDir: "/", target: "jpeg",
    qualityPreset: "original", resolutionCap: "original", imageOptions: {
      jpeg_quality: 90, resize: { kind: "fit_within", width: 2048, height: 2048 } } };
  it("restores full options and partial numeric text under each file identity", () => {
    const entries = { [fileKey]: { value: [file] },
      [JSON.stringify(["convert", "file", "photo-1", "ImageOptionsPanel.widthDraft"])]: { value: "-" },
      [JSON.stringify(["convert", "file", "photo-1", "ImageOptionsPanel.heightDraft"])]: { value: "" },
      [JSON.stringify(["convert", "file", "photo-2", "ImageOptionsPanel.qualityDraft"])]: { value: "1e" },
      [JSON.stringify(["convert", "file", "photo-1", "ImageOptionsPanel.appliedWidth"])]: { value: "2048" } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual(entries);
  });
  it("drops malformed options instead of restoring an ineffective draft", () => {
    const entries = { [fileKey]: { value: [{ ...file, imageOptions: { jpeg_quality: -1, resize: { kind: "original" } } }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual({});
  });
  it("continues restoring legacy drafts without image options", () => {
    const entries = { [fileKey]: { value: [{ ...file, imageOptions: undefined }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))[fileKey]).toEqual(entries[fileKey]);
  });
  it("rejects compression drafts carrying meaningful image options", () => {
    const entries = { [JSON.stringify(["compress", "CompressPage.files"])]: {
      value: [{ ...file, mode: { kind: "quality", value: 75 } }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual({});
  });
});


describe("video draft persistence", () => {
  it("retains dormant Automatic quality, incompatible target, Custom settings and blank text", () => {
    const custom = {kind:"encode",codec:"h264",processor:"software",speed:"medium",rate_control:{kind:"constant_quality",crf:23},resize:{kind:"fit_within",width:1920,height:1080},frame_rate:{kind:"constant",numerator:24000,denominator:1001}};
    const entries = {
      [JSON.stringify(["convert","ConvertPage.files"])]:{value:[{path:"/v.mp4",sourceDir:"/",target:"webm",qualityPreset:"balanced",videoOptions:custom}]},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.crfDraft"])]:{value:""},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.bitrateDraft"])]:{value:"-"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.widthDraft"])]:{value:""},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.heightDraft"])]:{value:"-"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.appliedWidth"])]:{value:"1920"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.appliedHeight"])]:{value:"1080"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.savedCustom"])]:{value:custom},
    };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual(entries);
  });
});

describe("audio draft persistence", () => {
  const audio = {
    kind: "encode",
    bitrate: { kind: "target", kbps: 320 },
    channels: { kind: "mono" },
    sample_rate: { kind: "exact", hz: 44_100 },
  };
  const fileKey = JSON.stringify(["convert", "ConvertPage.files"]);

  it("restores independently owned per-file and saved Custom options", () => {
    const entries = {
      [fileKey]: { value: [{ path: "/song.wav", sourceDir: "/", target: "mp3", audioOptions: audio }] },
      [JSON.stringify(["convert", "source", "/song.wav", "id", "AudioOptionsPanel.savedCustom"])]: { value: audio },
    };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored).toEqual(entries);
    expect(restored[fileKey].value).not.toBe(entries[fileKey].value);
  });

  it("drops malformed audio options without affecting legacy files", () => {
    const malformed = { [fileKey]: { value: [{ path: "/song.wav", sourceDir: "/", target: "mp3", audioOptions: { ...audio, extra: true } }] } };
    expect(decodeDraftEntries(encodeDraftEntries(malformed))).toEqual({});
    const legacy = { [fileKey]: { value: [{ path: "/song.wav", sourceDir: "/", target: "mp3" }] } };
    expect(decodeDraftEntries(encodeDraftEntries(legacy))).toEqual(legacy);
  });
});
