<template>
  <span>{{ n }}</span>
</template>

<script
  setup
  lang="ts"
>
export function double(n: number): number {
  return n * 2;
}
</script>
