# Abstract

Shared bicycles change how residents plan short trips, choose routes, and combine modes of transport. We describe a fictional study of 1,204 riders across six cities (*N* = 1,204) and report how station placement, pricing, and weather relate to weekly use. Station density explained the largest share of variance in trips per rider, and the association held in every city.

***Keywords:*** bicycle sharing; urban mobility; station placement; travel behavior; measurement

# 1. Introduction

City bike-share systems now operate in hundreds of cities. Riders use them for commuting, errands, and leisure, and each use depends on whether a working bicycle is close by when it is needed.

These systems require more than enthusiasm for active travel. Operators must balance fleet size against demand, and riders must trust that a dock will be free at the end of a trip (Rivera & Chen, 2021). Planners also need evidence about which design choices matter most.

Research on these questions remains fragmented. Studies span transport engineering, public health, and urban economics, and they rarely share a common measure of use.

## 1.1. Measurement Gap

Existing measures count trips, but they differ in what they treat as a trip and how they handle rebalancing by operators.

The present study focuses on the choices riders make before, during, and after each ride, and on how station design shapes those choices.

Station placement makes these established travel decisions relevant to specific design questions, such as spacing, dock count, and proximity to transit.

## 1.2. Conceptual Framework

We define bike-share use as the set of observable trips a rider starts and completes within a week, grouped by purpose.

**Table 1**

*Station Conditions and Rider Responses*

| **Station condition** | **Station function** | **Rider response** | **Example measure** |
|:---|:---|:---|:---|
| Uncertain availability: variable demand, empty docks at peak hours | Signal availability | Plan ahead | Share of trips started after checking the app |
| Changing routes: new lanes, closed streets, detours | Guide routing | Adapt the route | Median detour length in meters |
| Pricing changes as membership plans expand | Set incentives | Compare costs | Trips per rider after a price change |

*Note.* Rows describe fictional conditions used only to exercise the renderer.

## 1.3. Hypotheses

We expected three patterns:

1. Denser station networks would increase weekly trips.
2. Higher prices would reduce casual trips more than commuting trips.
3. Rain would reduce trips on the same day but not across the week.

Two further questions were exploratory:

- Whether distance to the nearest transit stop moderates the density effect.
- Whether the effects differ between members and casual riders.

Weekly trips were modeled as $y_{ij} = \beta_0 + \beta_1 d_{j} + u_j + e_{ij}$, where $d_j$ is station density in city $j$.

$$
R^2_{\text{marginal}} = \frac{\sigma^2_f}{\sigma^2_f + \sigma^2_u + \sigma^2_e}
$$

Density was measured as docks per square kilometer within 500 m of each rider's home.[^density]

[^density]: Fictional; chosen only to exercise footnote rendering.

> A blockquote, to check that quoted material renders and stays editable as raw source.

```text
code blocks fall back to raw-source editing
```

Water is H~2~O and the area is 2^10^ square meters, which exercises sub- and superscripts.

---

## 1.4. Data Sources

Trip records came from six fictional operators. Each record lists a start station, an end station, a start time, and a duration in seconds.

**Figure 1**


*Conceptual Model of Station Density and Use*

![Conceptual model: station density, pricing, and weather feed into weekly trips.](media/sample/figure-1.png){width="6.5in"}

*Note.* Arrows show the hypothesized direction of each association. The model is illustrative.

## 1.5. Contributions

The study offers a common measure of use, a comparison across six cities, and a template for evaluating station design.

# 2. Method

## 2.1. Participants

Riders were recruited through operator newsletters. Table 2 summarizes the sample.

**Table 2**

*Sample Characteristics by City*

| City | *n* | Members (%) | Median age |
|:---|---:|---:|---:|
| Alder | 190 | 48 | 29 |
| Birch | 197 | 51 | 30 |
| Cedar | 204 | 54 | 31 |
| Dogwood | 211 | 57 | 32 |
| Elm | 218 | 60 | 33 |
| Fir | 225 | 63 | 34 |

## 2.2. Measures

Weekly trips, trip purpose, and membership status were taken from operator records. Weather came from the nearest public station.

# 3. Results

Station density was associated with more weekly trips in every city (see Table 1 and Figure 1).

# References

Rivera, A., & Chen, B. (2021). Docking decisions in shared mobility. *Journal of Fictional Transport*, *12*(3), 45–67.
