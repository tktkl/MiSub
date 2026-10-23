<script setup>
    import { useI18n } from '@/i18n/index.js';
    defineProps({ isPinging: Boolean });
    const emit = defineEmits(['ping', 'duplicate', 'edit', 'delete']);
    const { t } = useI18n();
    const actions = [
        {
            event: 'ping',
            label: 'actions.ping',
            path: 'M13 10V3L4 14h7v7l9-11h-7z',
            color: 'hover:bg-green-500/10 hover:text-green-500',
        },
        {
            event: 'duplicate',
            label: 'actions.copyNode',
            path: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
            color: 'hover:bg-primary-500/10 hover:text-primary-500',
        },
        {
            event: 'edit',
            label: 'actions.edit',
            path: 'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.536L16.732 3.732z',
            color: 'hover:bg-gray-500/10 hover:text-gray-600 dark:hover:text-gray-200',
        },
        {
            event: 'delete',
            label: 'actions.delete',
            path: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
            color: 'hover:bg-red-500/10 hover:text-red-500',
        },
    ];
</script>

<template>
    <div class="flex shrink-0 items-center gap-1">
        <button
            v-for="action in actions"
            :key="action.event"
            type="button"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-400"
            :class="[
                action.color,
                { 'animate-pulse text-green-500': action.event === 'ping' && isPinging },
            ]"
            :title="t(action.label)"
            :aria-label="t(action.label)"
            :disabled="action.event === 'ping' && isPinging"
            @click.stop="emit(action.event)"
        >
            <svg
                class="h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
            >
                <path stroke-linecap="round" stroke-linejoin="round" :d="action.path" />
            </svg>
        </button>
    </div>
</template>
