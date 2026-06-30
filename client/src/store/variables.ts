import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { Variables } from '../types/variables';

export const useVariablesStore = defineStore('variables', () => {
  // State: per-channel variables
  const channelVariables = ref<Map<string, Variables>>(new Map());

  // Getters
  const getVariables = computed(() => {
    return (channelId: string): Variables => {
      return channelVariables.value.get(channelId) || {};
    };
  });

  const getVariable = computed(() => {
    return (channelId: string, name: string): Variables[string] | undefined => {
      return channelVariables.value.get(channelId)?.[name];
    };
  });

  // Actions
  function setVariables(channelId: string, variables: Variables): void {
    const current = channelVariables.value.get(channelId) || {};
    channelVariables.value.set(channelId, { ...current, ...variables });
  }

  function updateVariable(
    channelId: string,
    name: string,
    value: Variables[string]
  ): void {
    const current = channelVariables.value.get(channelId) || {};
    current[name] = value;
    channelVariables.value.set(channelId, current);
  }

  function clearVariables(channelId: string): void {
    channelVariables.value.delete(channelId);
  }

  return {
    // State
    channelVariables,

    // Getters
    getVariables,
    getVariable,

    // Actions
    setVariables,
    updateVariable,
    clearVariables,
  };
});
