import { logger } from "@truffle/db/logger";
const debug = logger("db:resources:networks:resolveRelations");

import type { Input, IdObject, Workspace } from "../types";

const relationshipProperties = (relationship: "ancestor" | "descendant") =>
  relationship === "ancestor"
    ? ({
        reverseRelationship: "descendant",
        superlativeOption: "onlyEarliest",
        heightOrder: "desc",
        heightBoundOption: "minimumHeight",
        heightBoundComparison: "$gte",
        comparator: (a, b) => b.historicBlock.height - a.historicBlock.height
      } as const)
    : ({
        reverseRelationship: "ancestor",
        superlativeOption: "onlyLatest",
        heightOrder: "asc",
        heightBoundOption: "maximumHeight",
        heightBoundComparison: "$gte",
        comparator: (a, b) => a.historicBlock.height - b.historicBlock.height
      } as const);

export const resolveAncestors = resolveRelations("ancestor");
export const resolveDescendants = resolveRelations("descendant");

export function resolveRelations(relationship: "ancestor" | "descendant") {
  const {
    reverseRelationship,
    superlativeOption,
    heightBoundOption,
    heightBoundComparison
  } = relationshipProperties(relationship);

  return async (
    network: IdObject<"networks">,
    options,
    { workspace }: { workspace: Workspace }
  ) => {
    const {
      limit,
      includeSelf = false,
      batchSize = 10,
      [superlativeOption]: onlySuperlative,
      [heightBoundOption]: heightBound,
      comparator
    } = options;

    const heightBoundSelector =
      typeof heightBound === "number"
        ? { [heightBoundComparison]: heightBound }
        : { $gte: 0 }; // pouch needs this for some reason

    //
    // process:
    //
    // track related networks as we've found them from the workspace, as well
    // as the set of IDs we know to have no further relations ("superlatives")
    const networks: { [id: string]: Input<"networks"> } = {};
    const superlatives: Set<string> = new Set([]);
    //
    // iteratively search genealogy records (e.g. when looking for ancestors,
    // look for records that specify unsearchedGenealogies as descendant)
    //
    // start by marking root network for this search and proceed so long as
    // there are additional genealogies to search
    let unsearchedGenealogies: IdObject<"networks">[] = [network];
    const genealogiesExhausted = () => unsearchedGenealogies.length === 0;
    //
    // track depth for optionally-specified limit
    let depth = 1;
    const exceededDepth = () => typeof limit === "number" && depth > limit;
    //
    // as we iterate over genealogy records, prepare batches of known relations
    // for lookup from workspace. found inputs may be included in return result
    // (pending superlativity when [superlativeOnly])
    let unsearchedInputs: IdObject<"networks">[] = includeSelf ? [network] : [];
    const batchReady = () => unsearchedInputs.length >= batchSize;
    //
    // since we're dealing with a DAG and not just a tree, it's possible that
    // we might encounter the same network twice in our search. we don't need
    // to search for anything in our collected networks or in our next batch
    const requiresSearch = ({ id }) =>
      !(id in networks) && !unsearchedInputs.map(({ id }) => id).includes(id);
    //
    // iterate:
    const done = () => genealogiesExhausted() || exceededDepth();
    while (!done()) {
      debug("depth %d", depth);
      debug("unsearchedGenealogies %o", unsearchedGenealogies);

      // conduct this iteration's genealogy search
      const networkGenealogies: Input<
        "networkGenealogies"
      >[] = await workspace.find("networkGenealogies", {
        selector: {
          [`${reverseRelationship}.id`]: {
            $in: unsearchedGenealogies.map(({ id }) => id)
          }
        }
      });
      debug("networkGenealogies %o", networkGenealogies);

      // track any superlatives
      const hasRelation = new Set(
        networkGenealogies.map(({ [reverseRelationship]: { id } }) => id)
      );
      const missingRelation = unsearchedGenealogies.filter(
        ({ id }) => !hasRelation.has(id)
      );
      for (const { id } of missingRelation) {
        superlatives.add(id);
      }
      debug(
        "found %o superlatives: %O",
        missingRelation.length,
        missingRelation
      );

      // prepare for next iteration - since we searched genealogies by
      // [reverseRelationship], we next must search all the [relationship]s,
      // except for those we already know about as a relation
      unsearchedGenealogies = networkGenealogies
        .map(({ [relationship]: { id } }) => ({ id }))
        .filter(requiresSearch);

      // add these to the current batch for possible network lookup
      unsearchedInputs.push(...unsearchedGenealogies);

      // increase depth
      depth++;

      // fetch batch when we have enough or at the end when we're done
      if (batchReady() || done()) {
        // fetch from workspace
        for (const input of await workspace.find("networks", {
          selector: {
            "id": { $in: unsearchedInputs.map(({ id }) => id) },
            "historicBlock.height": heightBoundSelector
          }
        })) {
          // track only found results
          //
          // anything missing is either out of height bounds or an unknown ID
          // (silently skip unknown IDs in order to be tolerant of corruption)
          if (input) {
            const { id } = input;
            networks[id] = input;
          }
        }

        // reset for next batch
        unsearchedInputs = [];

        // we can safely cull our list of networks for the genealogy search:
        // we **just** looked up everything we knew about as a possibility;
        // whatever's missing can be subsequently ignored
        unsearchedGenealogies = unsearchedGenealogies.filter(requiresSearch);
      }
    }

    const relations = onlySuperlative
      ? [...superlatives].map(id => networks[id])
      : Object.values(networks);

    return relations.sort(comparator);
  };
}
