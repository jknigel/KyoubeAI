import { useCallback, useEffect, useState } from "react";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { TERMINAL_PATH, type ApplyAnswer, type LicenceStatusAnswer } from "../shared.js";
import { errorText } from "./error-text.js";
import { LicencePanel } from "./LicencePanel.js";

export function LicenceSettingsPage(_props: PluginSettingsPageProps) {
  const navigation = useHostNavigation();
  const status = usePluginAction("license.status");
  const apply = usePluginAction("license.apply");
  const clear = usePluginAction("license.clear");
  const [answer, setAnswer] = useState<LicenceStatusAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyText, setKeyText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    status({}).then((result) => setAnswer(result as LicenceStatusAnswer), (caught) => setError(errorText(caught)));
  }, [status]);
  useEffect(load, [load]);

  const run = (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    action()
      .then((result) => {
        const outcome = result as ApplyAnswer;
        if (outcome.ok) {
          setAnswer(outcome.view);
          setKeyText("");
          setNotice(done);
        } else {
          setError(outcome.message);
        }
      }, (caught) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <LicencePanel
      answer={answer}
      error={error}
      keyText={keyText}
      busy={busy}
      notice={notice}
      onKeyText={setKeyText}
      onApply={() => run(() => apply({ key: keyText }), "Licence applied.")}
      onClear={() => { if (window.confirm("Remove the licence key? The free limit of 5 users applies again.")) run(() => clear({}), "Licence removed."); }}
      terminalLinkProps={{ ...navigation.linkProps(TERMINAL_PATH) }}
    />
  );
}
