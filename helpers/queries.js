import { app, beforeExit, sparqlEscapeUri, sparqlEscapeString } from 'mu';
import { querySudo as query } from '@lblod/mu-auth-sudo';

export async function addDeviceAndFilters({ deviceId, filter }) {
  const filterUUID = crypto.randomUUID();
const filterIRI = `http://example.org/filter/${filterUUID}`;

  const q = `
  PREFIX ex: <http://example.org/schema#>

  INSERT DATA {
    GRAPH <http://example.org/graph/devices> {
      <http://example.org/device/${deviceId}> a ex:Device ;
          ex:deviceId "${deviceId}" .

      <${filterIRI}> a ex:Filter ;
          ex:filterData """${JSON.stringify(filter)}""" .

      <http://example.org/device/${deviceId}> ex:hasFilter <${filterIRI}> .
    }
  }
  `;

  const result = await query(q);
  return result.results.bindings || [];
}

export async function getAllFilters() {
  const q = `
  PREFIX ex: <http://example.org/schema#>

  SELECT ?device ?deviceId ?filter ?filterData
  FROM <http://example.org/graph/devices>
  WHERE {
    ?device a ex:Device ;
            ex:deviceId ?deviceId ;
            ex:hasFilter ?filter .

    ?filter a ex:Filter ;
            ex:filterData ?filterData .
  }
  `;
  const result = await query(q);
  return result.results.bindings.map(b => ({
    device: b.device.value,
    deviceId: b.deviceId.value,
    filter: b.filter.value,
    filterData: JSON.parse(b.filterData.value)
  }));
}
