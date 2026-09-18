<template>
  <div class="comp">{{ label }}</div>
</template>

<script setup lang="ts">
/** 回归用组件：这段说明要能被提取出来 */
export interface Props {
  label: string;
}

function greet(name: string): string {
  return `hi ${name}`;
}

const pretty = (s: string): string => s.trim();
</script>

<style scoped>
.comp { color: red; }
</style>
