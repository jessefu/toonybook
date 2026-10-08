import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { signOut } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';
import { localizeHref } from '@/paraglide/runtime.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Account deletion.
 *
 * Two guards sit in front of an irreversible action. The user has to type the
 * email on the account (checked again on the server, so a replayed request
 * cannot lean on a session cookie alone), and deletion is refused while a
 * subscription can still renew — cancelling is one click in Billing and keeps
 * the access they have already paid for.
 */
export function DeleteAccountCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => apiPost('/api/user/account/delete', { email: typed }),
    onSuccess: async () => {
      toast.success(m['settings.profile.deleted']());
      // The session row is gone, so this call has nothing left to revoke —
      // best effort, and the reload below is what actually clears the client.
      await signOut().catch(() => undefined);
      // A full reload, not a router push: every cached query in memory belongs
      // to an account that no longer exists.
      window.location.href = localizeHref('/');
    },
    onError: (error: Error) => {
      const reason = error.message;
      if (reason === 'active_subscription') {
        setBlocked(true);
        return;
      }
      if (reason === 'email_mismatch') {
        setMismatch(true);
        return;
      }
      toast.error(reason || m['settings.profile.delete_failed']());
    },
  });

  function close(next: boolean) {
    if (deleteMutation.isPending) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setBlocked(false);
      setMismatch(false);
    }
  }

  const canSubmit =
    typed.trim().length > 0 &&
    typed.trim().toLowerCase() === email.trim().toLowerCase();

  return (
    <div className="px-6 pb-6">
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2">
            <Trash2 className="size-4" />
            {m['settings.profile.delete_title']()}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-muted-foreground max-w-md text-sm">
            {m['settings.profile.delete_description']()}
          </p>
          <Button
            type="button"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => setOpen(true)}
          >
            {m['settings.profile.delete_button']()}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {m['settings.profile.delete_dialog_title']()}
            </DialogTitle>
            <DialogDescription>
              {m['settings.profile.delete_dialog_description']()}
            </DialogDescription>
          </DialogHeader>

          {/* An active subscription is the one thing that stops this: the
              account cannot be deleted while it would keep billing. */}
          {blocked ? (
            <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-col gap-2 rounded-lg border p-3 text-sm">
              <span className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {m['settings.profile.delete_blocked_subscription']()}
              </span>
              <Link
                href="/settings/billing"
                className="font-medium underline underline-offset-2"
                onClick={() => close(false)}
              >
                {m['settings.profile.delete_go_to_billing']()}
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="delete-account-confirm">
                {m['settings.profile.delete_confirm_label']({ email })}
              </Label>
              <Input
                id="delete-account-confirm"
                autoComplete="off"
                value={typed}
                placeholder={m['settings.profile.delete_confirm_placeholder']()}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setMismatch(false);
                }}
              />
              {mismatch && (
                <p className="text-destructive text-sm">
                  {m['settings.profile.delete_confirm_mismatch']()}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteMutation.isPending}
              onClick={() => close(false)}
            >
              {m['settings.profile.delete_cancel']()}
            </Button>
            {!blocked && (
              <Button
                type="button"
                variant="destructive"
                disabled={!canSubmit || deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {deleteMutation.isPending
                  ? m['settings.profile.delete_deleting']()
                  : m['settings.profile.delete_confirm_action']()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
