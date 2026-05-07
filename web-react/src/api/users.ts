import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ChannelIdentityCreateInput,
  ChannelIdentityRecord,
  ChannelIdentityUpdateInput,
  UserCreateInput,
  UserRecord,
  UserUpdateInput,
} from "@/api/types";

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () =>
      apiFetch<{ users: UserRecord[] }>("/api/users").then((data) => data.users ?? []),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UserCreateInput) =>
      apiFetch<{ user: UserRecord }>("/api/users", { method: "POST", body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: UserUpdateInput }) =>
      apiFetch<{ user: UserRecord }>(`/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: update,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function useCreateChannelIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: ChannelIdentityCreateInput }) =>
      apiFetch<{ identity: ChannelIdentityRecord }>(
        `/api/users/${encodeURIComponent(userId)}/channel-identities`,
        { method: "POST", body: input },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function useUpdateChannelIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: ChannelIdentityUpdateInput }) =>
      apiFetch<{ identity: ChannelIdentityRecord }>(
        `/api/channel-identities/${encodeURIComponent(id)}`,
        { method: "PATCH", body: update },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function useDeleteChannelIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/channel-identities/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}
