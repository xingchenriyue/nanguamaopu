/**
 * utils/rating.js —— 评分列表转换与默认评分生成
 * ============================================================================
 * 【职责】评分列表转换与默认评分生成。
 * 【依赖】无
 * 【注意事项】纯函数，无副作用、不请求后端。
 * ============================================================================
 */
const ratingMap = {
  r1: "猫德",
  r2: "颜值",
  r3: "社交",
  r4: "干饭",
  r5: "活力",
}

function convertRatingList(data) {
  let ratings = [];
  for (const key in data) {
    if (!ratingMap[key]) {
      continue
    }
    ratings.push({
      key,
      name: ratingMap[key],
      score: data[key],
      scoreDisp: data[key].toFixed(1),
    });
  }

  return ratings;
}


function genDefaultRating() {
  let res = [];
  for (const key in ratingMap) {
    res.push({
      key,
      name: ratingMap[key],
      score: 0,
    })
  }
  return res;
}


export {
  convertRatingList,
  genDefaultRating
}