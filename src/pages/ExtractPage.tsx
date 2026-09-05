import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useSearchParams } from "react-router-dom";
import UrlHero from "@/features/extract/UrlHero";

function ExtractPage() {
  const [params] = useSearchParams();
  const url = params.get("url") ?? undefined;
  return <UrlHero url={url} />;
}

export default withWorkspaceDrafts(ExtractPage, "extract");
