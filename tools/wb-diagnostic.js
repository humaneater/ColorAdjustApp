"use strict";

const wb = require("../white-balance.js");

function show(label, matrix) {
  console.log(`\n${label}`);
  for (let row = 0; row < 3; row += 1) {
    console.log(
      "  " +
        matrix
          .slice(row * 3, row * 3 + 3)
          .map((value) => value.toFixed(4).padStart(9))
          .join(" "),
    );
  }
}

for (const kelvin of [2000, 3000, 5000, 6500, 9000, 12000]) {
  const matrix = wb.matrixFromKelvin(kelvin, 0);

  show(`色温 ${kelvin}K`, matrix);
  console.log(
    `  灰阶响应 ${wb
      .apply3(matrix, [1, 1, 1])
      .map((value) => value.toFixed(4))
      .join(", ")}`,
  );
}

console.log("\n6500K 时与单位矩阵的最大偏差：");
console.log(
  "  " +
    wb.maxAbsDifference(wb.matrixFromKelvin(6500, 0), wb.identity3()).toExponential(3),
);

console.log("\n轨迹连续性检查（相邻 1K 的 xy 跳变）：");
for (const kelvin of [3300, 3900, 4000, 4500, 5000]) {
  const current = wb.cctToXy(kelvin, 0);
  const next = wb.cctToXy(kelvin + 1, 0);

  console.log(
    `  ${kelvin}K → ${(kelvin + 1)}K: Δx=${Math.abs(next[0] - current[0]).toExponential(2)} Δy=${Math.abs(next[1] - current[1]).toExponential(2)}`,
  );
}

console.log("\n估算往返（把矩阵的等效色温重新代回色温模式）：");
for (const kelvin of [2800, 4200, 5600, 7800]) {
  const matrix = wb.matrixFromKelvin(kelvin, 0);
  const white = wb.apply3(wb.invert3(matrix), [1, 1, 1]);
  const xy = wb.linearRgbToXy(white);
  const solved = wb.xyToCct(xy[0], xy[1]);

  console.log(
    `  ${kelvin}K → 解出 ${solved.kelvin.toFixed(0)}K (色调 ${solved.tint.toFixed(2)}, Duv ${solved.duv.toFixed(4)})`,
  );
}

console.log("\nDuv 符号：");
for (const duv of [-0.015, -0.005, 0, 0.005, 0.015]) {
  const xy = wb.cctToXy(5500, duv);
  const solved = wb.xyToCct(xy[0], xy[1]);

  console.log(
    `  设定 Duv=${duv.toFixed(3)} → 解出 ${solved.duv.toFixed(4)}（色调 ${solved.tint.toFixed(1)}）`,
  );
}
