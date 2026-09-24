/**
 * The company-scoped route segment of the Apps page: the gallery is
 * `/<company>/app-artifact` and an app runs at `/<company>/app-artifact/<slug>`.
 *
 * It is deliberately not "apps": the upstream core owns `/<company>/apps` for
 * its Connectors catalogue, and React Router ranks that static route above the
 * host's `:pluginRoutePath/*` mount, so a plugin page registered there never
 * renders. Upstream's reserved-segment check (`PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS`)
 * does not list "apps", which is why the manifest installed without complaint
 * while the sidebar link landed on the dashboard (the Connectors gate's redirect
 * when its feature flag is off). Any future rename must again avoid every static
 * segment in upstream's `ui/src/App.tsx`, not only the reserved list.
 *
 * This module has no imports on purpose: the manifest (worker bundle), the UI
 * bundle and the tests all read the segment from here.
 */
export const APPS_PAGE_ROUTE = "app-artifact";

/** `/app-artifact` for the gallery, `/app-artifact/<slug>` for one app — host-relative, the host prefixes the company. */
export function appsPagePath(slug?: string | null): string {
  return slug ? `/${APPS_PAGE_ROUTE}/${slug}` : `/${APPS_PAGE_ROUTE}`;
}
