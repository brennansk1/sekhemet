// The glob engine lives in @sekhemet/sandbox because the permission engine needs
// it to evaluate scope patterns. Re-exported here so tool code can import it
// from its own package.
export { globToRegExp, matchesGlob } from "@sekhemet/sandbox";
