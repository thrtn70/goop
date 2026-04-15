import { useSearchParams } from "react-router-dom";
import UrlHero from "@/features/extract/UrlHero";

export default function ExtractPage() {
  const [params] = useSearchParams();
  const url = params.get("url") ?? undefined;
  return <UrlHero url={url} />;
}
