import { useMemo } from "react";
import { useHostContext, useHostLocation, useHostNavigation, type HostNavigation } from "@paperclipai/plugin-sdk/ui";

/** Host navigation that adds the company prefix from the URL when the host context has none (the Dashboard's widgets). */
export function useCompanyNavigation(): HostNavigation {
  const navigation = useHostNavigation();
  const host = useHostContext();
  const location = useHostLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  const prefix = !host.companyPrefix && segments.length > 1 ? segments[0]! : null;
  return useMemo(() => {
    if (!prefix) return navigation;
    const withPrefix = (to: string) => (to.startsWith("/") && !to.startsWith("//") && !to.startsWith(`/${prefix}/`) ? `/${prefix}${to}` : to);
    return {
      resolveHref: (to) => navigation.resolveHref(withPrefix(to)),
      navigate: (to, options) => navigation.navigate(withPrefix(to), options),
      linkProps: (to, options) => navigation.linkProps(withPrefix(to), options),
    };
  }, [navigation, prefix]);
}
