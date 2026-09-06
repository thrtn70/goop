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
