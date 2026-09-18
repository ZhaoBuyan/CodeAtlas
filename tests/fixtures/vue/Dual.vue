<script lang="ts">
export const shared = 1;
</script>

<script setup lang="ts">
export function fromSetup(): number {
  return shared + 1;
}
</script>
