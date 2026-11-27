const inputs: readonly number[] = [7, 14, 21];
const total: number = inputs.reduce((left, right) => left + right, 0);
console.log(`GhostFleet fixture ${total}`);
